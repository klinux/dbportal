/**
 * Amazon Athena transport over the AWS SDK
 *
 * The only implementation of the {@link AthenaTransport} seam, and the only file
 * in the provider allowed to know the SDK: its client, its command classes, the
 * shape of a query execution, a result page and a table's metadata, the
 * pagination tokens, and the exception names the service answers with.
 * `seam-guard.test.ts` fails the build the moment any of that appears elsewhere
 * in the directory.
 *
 * WHY THE SDK AND NOT `fetch`. Every other HTTP provider in this repo reaches its
 * engine with the runtime's own `fetch`, and `docs/ADDING_A_PROVIDER.md` names
 * SigV4 as the point where that promise ends: a request to this service is signed
 * with a four-step HMAC chain over a canonical request, and a signing routine
 * written here would be a second implementation of something the SDK already
 * gets right, retries correctly, and - the deciding argument - resolves
 * credentials for. A connection that carries no key pair is served by the SDK's
 * own provider chain (environment, shared config, an instance or task role, a
 * web identity), which is exactly how a deployment that has a role available
 * should reach the service, and nothing written here could offer that.
 *
 * FOUR SERVICE FACTS drive nearly every decision here:
 *
 * 1. A STATEMENT IS A JOB. Submission answers an id; the job is polled until it
 *    reaches SUCCEEDED, FAILED or CANCELLED; only then can rows be read. There is
 *    no push and no long poll, so the loop below sleeps between reads with a
 *    backoff that starts fast, because most statements finish in a second or two,
 *    and settles at one read per second, because a long statement is billed for
 *    what it scans and not for how often it is asked about.
 * 2. ABANDONING THE POLL DOES NOT STOP THE JOB. It runs to completion on the
 *    service and is billed for every byte it scans, so every exit path that is not
 *    a completed answer stops it explicitly.
 * 3. A DML RESULT SET STARTS WITH A HEADER ROW. The first row of a SELECT's first
 *    page repeats the column names as data; a DDL or utility answer carries no
 *    such row. Reading the rows without dropping it would hand the grid a row of
 *    column names dressed as values.
 * 4. EVERY CELL IS TEXT. A `bigint`, a `double` and a `boolean` all arrive as a
 *    string, beside a column declaration naming the type. The decoding below is
 *    confined to the types whose text form is lossless; a `decimal` stays the
 *    exact text it arrived as, because parsing it into a double is the one place
 *    precision would be destroyed silently.
 */

import { randomUUID } from "node:crypto";
import {
  AthenaClient,
  BatchGetQueryExecutionCommand,
  type Column,
  type ColumnInfo,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  GetTableMetadataCommand,
  GetWorkGroupCommand,
  ListDatabasesCommand,
  ListQueryExecutionsCommand,
  ListTableMetadataCommand,
  type QueryExecution,
  type Row,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
  type TableMetadata,
} from "@aws-sdk/client-athena";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import type { AthenaSettings } from "./settings";
import {
  ATHENA_DISPLAY_NAME,
  type AthenaColumn,
  type AthenaDatabase,
  type AthenaErrorCategory,
  type AthenaExecutionStats,
  type AthenaExecutionSummary,
  type AthenaQueryOptions,
  type AthenaQueryResult,
  type AthenaRow,
  type AthenaStatementType,
  type AthenaTable,
  type AthenaTableListing,
  type AthenaTransport,
  AthenaTransportError,
  type AthenaWorkgroupInfo,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The client this transport is built on, reduced to the two members it uses.
 *
 * The seam for TESTS rather than for a second product: a fake that answers
 * `send` per command class is how the whole transport is exercised without a
 * network, and the type is narrow so the fake needs nothing the transport does not
 * call.
 */
export type AthenaClientLike = Pick<AthenaClient, "send" | "destroy">;

/** What this transport may be handed instead of building its own client. */
export interface AthenaSdkTransportDeps {
  client?: AthenaClientLike;
  /**
   * The wait between two polls. Real time by default; a test hands in one that
   * does not sleep, so the poll loop's shape is exercised without its cadence.
   */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Attempts per REQUEST, which the SDK retries itself with exponential backoff on
 * a throttle or a transient service fault. Bounded because the alternative turns
 * a service that is down into a client that never returns.
 */
const MAX_ATTEMPTS = 4;

/**
 * The poll cadence: the first read after 200 ms, each wait half again as long as
 * the last, and never longer than a second. A statement over Glue metadata
 * finishes inside the first two reads; a statement over a terabyte is asked about
 * once a second, which is the cadence the service's own console uses.
 */
const POLL_INITIAL_MS = 200;
const POLL_GROWTH = 1.5;
const POLL_MAX_MS = 1_000;

/**
 * A runaway guard on the poll, not a deadline.
 *
 * The real bound is the caller's signal. This exists so a job the service never
 * moves to a terminal state cannot hold a request open forever when the caller
 * brought no signal, and hitting it is REPORTED rather than silently accepted.
 * At the settled cadence it is two hours, past the service's own thirty-minute
 * default for a statement.
 */
const MAX_POLLS = 7_200;

/** The most rows one result page can carry, which is the service's own ceiling. */
const RESULT_PAGE_SIZE = 1_000;

/**
 * A ceiling on the rows one statement may answer through this transport.
 *
 * The shared limiter bounds every SELECT before it is sent, so a query reaches this
 * only through a statement the limiter does not touch - `SHOW PARTITIONS` on a
 * table with a million of them - and past the bound the answer is REFUSED rather
 * than cut: a truncation nobody was told about is the failure mode this avoids.
 * Twice the limiter's own unlimited bound, so an export is never the statement
 * that trips it.
 */
const MAX_RESULT_ROWS = MAX_UNLIMITED_ROWS * 2;

/** The most tables and databases one metadata page can carry, the service's own ceiling. */
const METADATA_PAGE_SIZE = 50;

/**
 * The most databases one catalog listing reads before it is abandoned as runaway.
 * Five thousand databases in one Glue catalog is far past anything a region holds;
 * the guard exists so a service that keeps handing out tokens cannot spin.
 */
const MAX_DATABASE_PAGES = 100;

/** The most executions one batch description may name, the service's own ceiling. */
const EXECUTION_BATCH_SIZE = 50;

/**
 * Fault name -> category, exact match on the name the engine writes at the head
 * of a failed statement's reason: `SYNTAX_ERROR: line 1:1: mismatched input`,
 * `TABLE_NOT_FOUND: line 1:15: Table 'awsdatacatalog.db.t' does not exist`.
 *
 * The vocabulary is Trino's, because the engine behind Athena is a Trino fork
 * and the names are its own enum; only the ones the provider branches on are
 * listed, and an unlisted name arrives as text with the `engine` category.
 */
const FAULT_CATEGORIES: Readonly<Record<string, AthenaErrorCategory>> = Object.freeze({
  SYNTAX_ERROR: "syntax",
  CATALOG_NOT_FOUND: "unknown-object",
  SCHEMA_NOT_FOUND: "unknown-object",
  TABLE_NOT_FOUND: "unknown-object",
  COLUMN_NOT_FOUND: "unknown-object",
  FUNCTION_NOT_FOUND: "unknown-object",
  NOT_SUPPORTED: "unsupported",
  PERMISSION_DENIED: "auth",
  USER_CANCELED: "cancelled",
  EXCEEDED_TIME_LIMIT: "timeout",
  EXCEEDED_MEMORY_LIMIT: "resources",
  INSUFFICIENT_RESOURCES: "resources",
});

/** The fault name at the head of a failure reason, when the engine wrote one. */
const FAULT_NAME = /^([A-Z][A-Z_]+):/;

/**
 * The exception names the service answers a request with before it becomes a
 * statement, each mapped to a category. Matched on the NAME, which is the
 * service's own stable identifier for the refusal; the SDK's class hierarchy
 * carries only the few the Athena API models, while a refused signature or an
 * expired session arrives as the generic service exception with one of these
 * names on it.
 */
const EXCEPTION_CATEGORIES: Readonly<Record<string, AthenaErrorCategory>> = Object.freeze({
  AccessDeniedException: "auth",
  UnrecognizedClientException: "auth",
  InvalidSignatureException: "auth",
  SignatureDoesNotMatch: "auth",
  InvalidClientTokenId: "auth",
  ExpiredTokenException: "auth",
  ExpiredToken: "auth",
  IncompleteSignatureException: "auth",
  // The SDK's own provider chain found nothing to sign with: no key pair on the
  // connection and no role in the environment.
  CredentialsProviderError: "auth",
  TooManyRequestsException: "resources",
  ThrottlingException: "resources",
  Throttling: "resources",
  ResourceNotFoundException: "unknown-object",
});

/** The states a job is no longer in flight in. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * The column types whose text form decodes losslessly, and how.
 *
 * Integers are parsed only while they fit a double exactly; a `bigint` past 2^53
 * stays the text the service rendered, which is what the `pg` driver does for
 * `int8`. Floating types are parsed when finite and left as text for `NaN` and
 * the infinities, which the engine renders as words. Nothing else is touched: a
 * `decimal` is exact only as text, and a timestamp's rendering is the engine's
 * own and the honest thing to show.
 */
const INTEGER_TYPES: ReadonlySet<string> = new Set(["tinyint", "smallint", "integer", "bigint"]);
const FLOAT_TYPES: ReadonlySet<string> = new Set(["real", "double", "float"]);
const BOOLEAN_TYPE = "boolean";
const INTEGER_TEXT = /^-?\d+$/;

/** The one trivia the statement may lose: whitespace around ONE trailing semicolon. */
const LONE_TERMINATOR = /^\s*;\s*$/;

// ============================================================================
// Pure helpers
// ============================================================================

/** A finite number the service reported, or null when it reported none. */
function reported(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/** Text the service reported as non-empty, or null. */
function textOf(value: string | undefined): string | null {
  return value !== undefined && value !== "" ? value : null;
}

/**
 * The statement without the terminator the engine refuses, or unchanged.
 *
 * The engine takes exactly one statement with no terminator, and a lone `;` a
 * caller wrote out of habit is a syntax error there rather than a no-op. Read
 * with the span reader (#280) so a `;` inside a literal or a trailing comment is
 * not the end of anything, and only a run that is exactly one semicolon is
 * dropped - `SELECT 1; SELECT 2` keeps failing the way the engine fails it.
 */
function withoutTerminator(sql: string, grammar: SqlGrammar): string {
  const { end, rewritable } = readStatementEnd(sql, grammar);
  return rewritable && LONE_TERMINATOR.test(sql.slice(end)) ? sql.slice(0, end) : sql;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // A caller who aborts must not have to wait out the poll interval first.
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The declared names, made unique, with their rendered types.
 *
 * `SELECT 1 AS c, 2 AS c` declares two columns both named `c`, and a row is a
 * record, so the repeat is disambiguated while the row is built or the second
 * column disappears before the seam. The suffix keeps climbing because
 * `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal too.
 */
function readColumns(declared: readonly ColumnInfo[]): {
  declaredNames: string[];
  names: string[];
  types: Record<string, string>;
} {
  const declaredNames: string[] = [];
  const names: string[] = [];
  const types: Record<string, string> = {};
  const taken = new Set<string>();

  for (const column of declared) {
    const declaredName = column.Name ?? "";
    let unique = declaredName;
    for (let repeat = 2; taken.has(unique); repeat += 1) unique = `${declaredName} (${repeat})`;
    taken.add(unique);
    declaredNames.push(declaredName);
    names.push(unique);
    types[unique] = column.Type ?? "";
  }

  return { declaredNames, names, types };
}

/** One cell's text, or null for a cell the service left absent, which is how it renders NULL. */
function cellText(row: Row, column: number): string | null {
  const datum = row.Data?.[column];
  return datum?.VarCharValue ?? null;
}

/** One cell, decoded where its declared type's text form is lossless (fact 4). */
function decodeCell(text: string | null, type: string): unknown {
  if (text === null) return null;
  if (INTEGER_TYPES.has(type)) {
    if (!INTEGER_TEXT.test(text)) return text;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : text;
  }
  if (FLOAT_TYPES.has(type)) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : text;
  }
  if (type === BOOLEAN_TYPE) {
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return text;
}

/**
 * Whether this row is the header the service prefixes a DML result set with
 * (fact 3): one cell per declared column, each spelling that column's declared
 * name. Checked on the first row of the first page only, and only for a DML
 * statement, so a data row that happens to repeat the names further down is
 * never dropped.
 */
function isHeaderRow(row: Row, declaredNames: readonly string[]): boolean {
  const cells = row.Data ?? [];
  return cells.length === declaredNames.length && declaredNames.every((name, at) => cells[at]?.VarCharValue === name);
}

function readStats(execution: QueryExecution): AthenaExecutionStats {
  const statistics = execution.Statistics;
  return {
    engineMs: reported(statistics?.EngineExecutionTimeInMillis),
    queuedMs: reported(statistics?.QueryQueueTimeInMillis),
    totalMs: reported(statistics?.TotalExecutionTimeInMillis),
    scannedBytes: reported(statistics?.DataScannedInBytes),
    resultLocation: textOf(execution.ResultConfiguration?.OutputLocation),
  };
}

function readStatementType(execution: QueryExecution): AthenaStatementType | null {
  const type = execution.StatementType;
  return type === "DDL" || type === "DML" || type === "UTILITY" ? type : null;
}

/** One catalog column, or nothing for an entry the catalog left unnamed. */
function readCatalogColumn(column: Column): AthenaColumn[] {
  const name = textOf(column.Name);
  return name === null ? [] : [{ name, type: column.Type ?? "" }];
}

/** One table's metadata as the seam carries it, or nothing for an entry the catalog left unnamed. */
function readTable(metadata: TableMetadata): AthenaTable[] {
  const name = textOf(metadata.Name);
  if (name === null) return [];
  return [
    {
      name,
      tableType: textOf(metadata.TableType),
      columns: (metadata.Columns ?? []).flatMap(readCatalogColumn),
      partitionKeys: (metadata.PartitionKeys ?? []).flatMap(readCatalogColumn),
      parameters: metadata.Parameters ?? {},
    },
  ];
}

/**
 * The failure a FAILED job reports.
 *
 * The reason's leading fault name is the classifier (`SYNTAX_ERROR:`), because it
 * is the engine's own stable enum; the numeric category the service attaches
 * beside it says only whose fault it was, so it is consulted for one thing - a
 * SYSTEM fault the service itself marks retryable is a resources refusal rather
 * than a statement the engine read and rejected.
 */
function jobFailure(execution: QueryExecution): AthenaTransportError {
  const status = execution.Status;
  const reason = textOf(status?.StateChangeReason) ?? textOf(status?.AthenaError?.ErrorMessage);
  const name = reason?.match(FAULT_NAME)?.[1] ?? null;
  const category =
    name !== null && name in FAULT_CATEGORIES
      ? (FAULT_CATEGORIES[name] as AthenaErrorCategory)
      : status?.AthenaError?.Retryable === true
        ? "resources"
        : "engine";

  return new AthenaTransportError(category, reason ?? `${ATHENA_DISPLAY_NAME} refused the statement`, name);
}

/**
 * The failure a thrown SDK call describes.
 *
 * The SIGNAL is consulted before the thrown value, because the thrown value is
 * not reliably abort-shaped: the SDK throws an `AbortError`, the poll's own delay
 * rethrows whatever reason the caller attached, and attaching a reason is the
 * normal way to say why a request was cancelled.
 *
 * A service exception carries `$fault`; an error without it never reached the
 * service - a refused socket, an unresolvable host, a body that stopped arriving -
 * and is unreachable rather than a refusal. The credentials chain's own failure is
 * the one exception without `$fault` that is a refusal, and its name is in the
 * table.
 */
function requestFailure(cause: unknown, signal?: AbortSignal): AthenaTransportError {
  if (signal?.aborted) {
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    return timedOut
      ? new AthenaTransportError("timeout", `${ATHENA_DISPLAY_NAME} did not answer before the deadline`)
      : new AthenaTransportError("cancelled", `The request to ${ATHENA_DISPLAY_NAME} was cancelled`);
  }
  if (cause instanceof AthenaTransportError) return cause;

  const error = cause instanceof Error ? cause : new Error(String(cause));
  const named = EXCEPTION_CATEGORIES[error.name];
  if (named !== undefined) return new AthenaTransportError(named, error.message, error.name);
  if ("$fault" in error) return new AthenaTransportError("engine", error.message, error.name);

  return new AthenaTransportError("unreachable", `${ATHENA_DISPLAY_NAME} could not be reached: ${error.message}`);
}

// ============================================================================
// Transport
// ============================================================================

export class AthenaSdkTransport implements AthenaTransport {
  private readonly client: AthenaClientLike;
  private readonly settings: AthenaSettings;
  private readonly grammar: SqlGrammar;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(settings: AthenaSettings, deps: AthenaSdkTransportDeps = {}) {
    this.settings = settings;
    this.grammar = resolveSqlGrammar("athena");
    this.wait = deps.delay ?? delay;
    this.client =
      deps.client ??
      new AthenaClient({
        region: settings.region,
        maxAttempts: MAX_ATTEMPTS,
        // A key pair on the connection is used as given; none at all hands the
        // decision to the SDK's provider chain, which is the point of allowing none.
        ...(settings.credentials === undefined ? {} : { credentials: settings.credentials }),
      });
  }

  public async query(sql: string, options: AthenaQueryOptions = {}): Promise<AthenaQueryResult> {
    const queryExecutionId = await this.submit(sql, options.signal);
    // Announced before the answer exists, because a caller that wants to cancel
    // has to learn the id while the statement is still running.
    options.onQueryStarted?.(queryExecutionId);

    try {
      const execution = await this.awaitCompletion(queryExecutionId, options.signal);
      return await this.readResult(queryExecutionId, execution, options.signal);
    } catch (error) {
      // Fact 2: abandoning the poll leaves the job running and scanning. Every exit
      // path that is not a completed answer - an abort, a deadline, a runaway poll,
      // a failure this client raised while reading rows - owes the service a stop.
      await this.abandon(queryExecutionId);
      throw error;
    }
  }

  public async cancel(queryExecutionId: string, signal?: AbortSignal): Promise<void> {
    await this.call(
      (o) => this.client.send(new StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId }), o),
      signal,
    );
  }

  public async listDatabases(): Promise<AthenaDatabase[]> {
    const databases: AthenaDatabase[] = [];
    let token: string | undefined;
    for (let page = 1; ; page += 1) {
      const answer = await this.call((o) =>
        this.client.send(
          new ListDatabasesCommand({
            CatalogName: this.settings.catalog,
            MaxResults: METADATA_PAGE_SIZE,
            ...(token === undefined ? {} : { NextToken: token }),
          }),
          o,
        ),
      );
      for (const database of answer.DatabaseList ?? []) {
        const name = textOf(database.Name);
        if (name !== null) databases.push({ name });
      }
      token = textOf(answer.NextToken) ?? undefined;
      if (token === undefined) return databases;
      if (page >= MAX_DATABASE_PAGES) {
        throw new AthenaTransportError(
          "engine",
          `${ATHENA_DISPLAY_NAME} kept listing databases past ${MAX_DATABASE_PAGES} pages, so the listing was abandoned rather than reported as complete`,
        );
      }
    }
  }

  public async listTables(database: string, limit: number): Promise<AthenaTableListing> {
    const tables: AthenaTable[] = [];
    let token: string | undefined;
    // One table past the ceiling is read on purpose: it is what tells a bounded
    // listing apart from a database that holds exactly `limit` tables.
    while (tables.length <= limit) {
      const answer = await this.call((o) =>
        this.client.send(
          new ListTableMetadataCommand({
            CatalogName: this.settings.catalog,
            DatabaseName: database,
            MaxResults: METADATA_PAGE_SIZE,
            ...(token === undefined ? {} : { NextToken: token }),
          }),
          o,
        ),
      );
      tables.push(...(answer.TableMetadataList ?? []).flatMap(readTable));
      token = textOf(answer.NextToken) ?? undefined;
      if (token === undefined) break;
    }

    return { tables: tables.slice(0, limit), truncated: tables.length > limit };
  }

  public async describeTable(database: string, name: string): Promise<AthenaTable | null> {
    try {
      const answer = await this.call((o) =>
        this.client.send(
          new GetTableMetadataCommand({ CatalogName: this.settings.catalog, DatabaseName: database, TableName: name }),
          o,
        ),
      );
      return answer.TableMetadata === undefined ? null : (readTable(answer.TableMetadata)[0] ?? null);
    } catch (error) {
      // The one refusal that IS an answer: the catalog holds no table of that
      // name. Every other failure - a denied permission above all - propagates,
      // because "no such table" over a denied read would render a dropped table.
      if (error instanceof AthenaTransportError && error.category === "unknown-object") return null;
      throw error;
    }
  }

  public async describeWorkgroup(): Promise<AthenaWorkgroupInfo> {
    const answer = await this.call((o) =>
      this.client.send(new GetWorkGroupCommand({ WorkGroup: this.settings.workgroup }), o),
    );
    const workgroup = answer.WorkGroup;
    const configuration = workgroup?.Configuration;
    return {
      name: textOf(workgroup?.Name) ?? this.settings.workgroup,
      state: textOf(workgroup?.State),
      engineVersion: textOf(configuration?.EngineVersion?.EffectiveEngineVersion),
      outputLocation: textOf(configuration?.ResultConfiguration?.OutputLocation),
      enforcesConfiguration: configuration?.EnforceWorkGroupConfiguration === true,
      bytesScannedCutoff: reported(configuration?.BytesScannedCutoffPerQuery),
    };
  }

  public async listExecutions(limit: number): Promise<AthenaExecutionSummary[]> {
    const ids: string[] = [];
    let token: string | undefined;
    while (ids.length < limit) {
      const answer = await this.call((o) =>
        this.client.send(
          new ListQueryExecutionsCommand({
            WorkGroup: this.settings.workgroup,
            MaxResults: Math.min(EXECUTION_BATCH_SIZE, limit - ids.length),
            ...(token === undefined ? {} : { NextToken: token }),
          }),
          o,
        ),
      );
      ids.push(...(answer.QueryExecutionIds ?? []).filter((id) => id !== ""));
      token = textOf(answer.NextToken) ?? undefined;
      if (token === undefined) break;
    }
    if (ids.length === 0) return [];

    // Described in the service's batch size and REORDERED to the listing's own
    // order, which is newest first: the batch answers in whatever order it likes.
    const described = new Map<string, QueryExecution>();
    for (let at = 0; at < ids.length; at += EXECUTION_BATCH_SIZE) {
      const batch = await this.call((o) =>
        this.client.send(
          new BatchGetQueryExecutionCommand({ QueryExecutionIds: ids.slice(at, at + EXECUTION_BATCH_SIZE) }),
          o,
        ),
      );
      for (const execution of batch.QueryExecutions ?? []) {
        const id = textOf(execution.QueryExecutionId);
        if (id !== null) described.set(id, execution);
      }
    }

    return ids.flatMap((id) => {
      const execution = described.get(id);
      if (execution === undefined) return [];
      const stats = readStats(execution);
      return [
        {
          queryExecutionId: id,
          statement: execution.Query ?? "",
          state: execution.Status?.State ?? "",
          database: textOf(execution.QueryExecutionContext?.Database),
          workgroup: textOf(execution.WorkGroup),
          submittedAt: execution.Status?.SubmissionDateTime ?? null,
          completedAt: execution.Status?.CompletionDateTime ?? null,
          engineMs: stats.engineMs,
          queuedMs: stats.queuedMs,
          scannedBytes: stats.scannedBytes,
        },
      ];
    });
  }

  /** Nothing pinned and no socket owned; the SDK's own connection pool is released. */
  public close(): Promise<void> {
    this.client.destroy();
    return Promise.resolve();
  }

  // ==========================================================================
  // One statement, in three acts
  // ==========================================================================

  private async submit(sql: string, signal?: AbortSignal): Promise<string> {
    const { catalog, database, workgroup, outputLocation } = this.settings;
    const answer = await this.call(
      (o) =>
        this.client.send(
          new StartQueryExecutionCommand({
            QueryString: withoutTerminator(sql, this.grammar),
            // Idempotent on the SDK's own retry: a submission whose acknowledgement was
            // lost is answered with the SAME job rather than started twice and billed twice.
            ClientRequestToken: randomUUID(),
            QueryExecutionContext: { Catalog: catalog, ...(database === undefined ? {} : { Database: database }) },
            WorkGroup: workgroup,
            ...(outputLocation === undefined ? {} : { ResultConfiguration: { OutputLocation: outputLocation } }),
          }),
          o,
        ),
      signal,
    );
    const id = textOf(answer.QueryExecutionId);
    if (id === null) {
      throw new AthenaTransportError(
        "unreachable",
        `${ATHENA_DISPLAY_NAME} accepted the statement without identifying it, so this is not the service`,
      );
    }
    return id;
  }

  /** Poll until the job leaves its in-flight states (fact 1). */
  private async awaitCompletion(queryExecutionId: string, signal?: AbortSignal): Promise<QueryExecution> {
    let wait = POLL_INITIAL_MS;
    for (let polls = 1; ; polls += 1) {
      try {
        await this.wait(wait, signal);
      } catch (error) {
        throw requestFailure(error, signal);
      }
      const answer = await this.call(
        (o) => this.client.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }), o),
        signal,
      );
      const execution = answer.QueryExecution ?? {};
      const state = execution.Status?.State ?? "";
      if (TERMINAL_STATES.has(state)) return execution;
      if (polls >= MAX_POLLS) {
        throw new AthenaTransportError(
          "timeout",
          `${ATHENA_DISPLAY_NAME} kept the statement in flight past ${MAX_POLLS} polls, so it was stopped rather than waited on`,
        );
      }
      wait = Math.min(Math.round(wait * POLL_GROWTH), POLL_MAX_MS);
    }
  }

  /**
   * The rows of a job that reached a terminal state, or the failure it reported.
   *
   * A CANCELLED job is reported as such rather than as empty: the service records
   * the stop whoever asked for it, and an empty grid would read as a statement
   * that matched nothing.
   */
  private async readResult(
    queryExecutionId: string,
    execution: QueryExecution,
    signal?: AbortSignal,
  ): Promise<AthenaQueryResult> {
    const state = execution.Status?.State;
    if (state === "FAILED") throw jobFailure(execution);
    if (state === "CANCELLED") {
      throw new AthenaTransportError(
        "cancelled",
        textOf(execution.Status?.StateChangeReason) ?? `The statement was cancelled on ${ATHENA_DISPLAY_NAME}`,
        "CANCELLED",
      );
    }

    const statementType = readStatementType(execution);
    const rows: AthenaRow[] = [];
    let declared: ReturnType<typeof readColumns> | null = null;
    let affectedRows: number | null = null;
    let token: string | undefined;
    let first = true;

    for (;;) {
      const page = await this.call(
        (o) =>
          this.client.send(
            new GetQueryResultsCommand({
              QueryExecutionId: queryExecutionId,
              MaxResults: RESULT_PAGE_SIZE,
              ...(token === undefined ? {} : { NextToken: token }),
            }),
            o,
          ),
        signal,
      );
      affectedRows = reported(page.UpdateCount) ?? affectedRows;
      // The declaration is read from the first page that carries one and held for
      // the whole read; a later page repeats it and a page of a DDL answer omits it.
      const columns = page.ResultSet?.ResultSetMetadata?.ColumnInfo;
      if (declared === null && columns !== undefined) declared = readColumns(columns);

      const pageRows = page.ResultSet?.Rows ?? [];
      const skipHeader = first && statementType === "DML" && declared !== null && pageRows.length > 0;
      const body = skipHeader && isHeaderRow(pageRows[0], declared!.declaredNames) ? pageRows.slice(1) : pageRows;
      first = false;
      if (body.length > 0 && declared === null) {
        throw new AthenaTransportError(
          "engine",
          `${ATHENA_DISPLAY_NAME} sent rows it never declared columns for, so they cannot be read`,
        );
      }
      for (const row of body) {
        rows.push(
          Object.fromEntries(
            declared!.names.map((name, at) => [name, decodeCell(cellText(row, at), declared!.types[name])]),
          ),
        );
      }
      if (rows.length > MAX_RESULT_ROWS) {
        throw new AthenaTransportError(
          "resources",
          `The statement answered more than ${MAX_RESULT_ROWS} rows, which this client refuses to read rather than cut short. Bound the statement with LIMIT.`,
        );
      }

      token = textOf(page.NextToken) ?? undefined;
      if (token === undefined) break;
    }

    return {
      rows,
      fieldNames: declared === null ? null : declared.names,
      columnTypes: declared === null ? null : declared.types,
      queryExecutionId,
      statementType,
      affectedRows,
      stats: readStats(execution),
    };
  }

  /** Stop a job this transport started, without letting the attempt mask the real failure. */
  private async abandon(queryExecutionId: string): Promise<void> {
    try {
      // Deliberately no signal: the caller's is very likely the aborted one that
      // brought us here, and passing it would abort the cleanup too.
      await this.cancel(queryExecutionId);
    } catch {
      // Best effort by construction. The statement's own failure is what the
      // caller asked about, and replacing it with "and the stop also failed" would
      // hide it.
    }
  }

  /**
   * One SDK call, with every failure leaving as the seam's error type.
   *
   * A thunk rather than a command parameter, so each call site keeps the SDK's own
   * inference of the command's output type instead of a generic wrapper erasing it.
   */
  private async call<T>(run: (options: { abortSignal?: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await run(signal === undefined ? {} : { abortSignal: signal });
    } catch (error) {
      throw requestFailure(error, signal);
    }
  }
}
