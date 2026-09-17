/**
 * Amazon Athena transport seam
 *
 * Provider logic never talks to AWS directly. It goes through this interface, so
 * the one implementation - `sdk-transport.ts`, the only file in the directory that
 * imports `@aws-sdk/client-athena` - can be replaced by a hand-built fake in every
 * test, and so nothing above the seam ever learns a command name, a field name of
 * the wire model or a pagination token. `seam-guard.test.ts` fails the build the
 * moment that vocabulary appears anywhere else in the directory. This is the
 * sibling of the Trino seam in `providers/sql/trino/transport.ts`, and it differs
 * from it in one structural way: the catalog is not read with SQL. Athena
 * publishes its databases, tables and columns through a metadata API that costs
 * no query execution and writes nothing to S3, so the seam carries those reads as
 * methods of their own rather than as statements.
 *
 * Three facts about the service shape almost every type below:
 *
 * - A STATEMENT IS A JOB. Submitting it answers an id and nothing else; the job is
 *   polled until it reaches a terminal state, and only then are the rows fetched,
 *   page by page. Abandoning the poll does NOT stop the job - it runs to completion
 *   on the service and is billed for the bytes it scans - so every exit path that is
 *   not a completed answer owes the service a cancellation.
 * - EVERY VALUE ARRIVES AS TEXT. The result API renders a bigint, a double, a
 *   boolean and a timestamp alike as a string cell, beside a column declaration
 *   that names the type. The implementation decodes the few types whose text form
 *   is lossless into JavaScript values and passes everything else through as the
 *   text the service rendered.
 * - THE BILL IS PER BYTE SCANNED. The execution report carries the number, and the
 *   seam carries it through, because it is the one figure an Athena user watches.
 *
 * Apart from the error type this file is purely structural: no I/O.
 */

/** How the service spells itself in text a user reads. */
export const ATHENA_DISPLAY_NAME = "Athena";

/**
 * The catalog every read resolves against.
 *
 * Athena's own default catalog, which is the AWS Glue Data Catalog of the account
 * and region the credentials reach. A federated catalog (a Lambda connector) is a
 * different name, and a fully qualified statement reaches one without this seam
 * knowing: `SELECT * FROM "my_lambda_catalog"."db"."t"` needs no pin.
 */
export const ATHENA_DEFAULT_CATALOG = "AwsDataCatalog";

/**
 * The workgroup a connection runs in when it names none.
 *
 * Every AWS account has one of this name, created by the service itself, so it is
 * the one default that cannot point at nothing.
 */
export const ATHENA_DEFAULT_WORKGROUP = "primary";

/** One result row, keyed by the names in {@link AthenaQueryResult.fieldNames}. */
export type AthenaRow = Record<string, unknown>;

/**
 * What the service classified the statement as, in its own three words.
 *
 * Carried because it decides how the rows are read: the service prefixes a DML
 * result set with a header row that repeats the column names, and prefixes a DDL
 * or utility answer with nothing. Null when the service reported no
 * classification, which a statement that failed before planning may do.
 */
export type AthenaStatementType = "DDL" | "DML" | "UTILITY";

/**
 * What the service reported about executing one statement.
 *
 * Every number is the SERVICE's own, and null means "the service did not say"
 * rather than zero: the report is complete only once the statement has reached a
 * terminal state, and a zero on a statement that never ran would claim it scanned
 * nothing.
 */
export interface AthenaExecutionStats {
  /** Milliseconds the engine spent running the statement, planning excluded. */
  engineMs: number | null;
  /** Milliseconds the statement waited for the workgroup to schedule it. */
  queuedMs: number | null;
  /** Wall-clock milliseconds from submission to the terminal state. */
  totalMs: number | null;
  /** The bytes read from S3 to answer, which is what the statement is billed for. */
  scannedBytes: number | null;
  /**
   * The S3 object the service wrote the result to, or null when it reported none.
   *
   * Carried for the user's own reference: every result lives in the bucket the
   * connection or the workgroup named, and it is the object an operator looks for
   * when reconciling a bill or a retention policy.
   */
  resultLocation: string | null;
}

/** Normalized outcome of one statement, after the job has completed and its rows were read. */
export interface AthenaQueryResult {
  rows: AthenaRow[];

  /**
   * Column order as the service declared it, or null when it never described the
   * rows.
   *
   * Declared order is authoritative and object keys are not: rows arrive
   * POSITIONALLY, as arrays of cells aligned to the declaration by index.
   *
   * INVARIANT the implementation must uphold: these names are UNIQUE and are
   * exactly the key set of every row. The service happily declares `SELECT 1 AS c,
   * 2 AS c` as two columns both named `c`, and a duplicate cannot survive into an
   * {@link AthenaRow}, so the implementation disambiguates while it rebuilds the
   * row.
   *
   * An EMPTY array is a real declaration of no columns, which is what a DDL
   * statement answers; null is the service declining to describe anything.
   */
  fieldNames: string[] | null;

  /**
   * The service's rendered type per column, keyed by the name in `fieldNames`:
   * `varchar`, `bigint`, `decimal`, `array`, `row`, `timestamp`.
   *
   * The rendered text, not a parsed structure, because it is the vocabulary a user
   * reads in `SHOW COLUMNS` and in their own DDL. Null exactly when `fieldNames`
   * is null.
   */
  columnTypes: Record<string, string> | null;

  /**
   * The service's id for this statement.
   *
   * Neutral despite looking like a wire detail: it is the handle a user needs to
   * find the statement in the Athena console and in CloudTrail, it names the
   * result object in S3, and it is the argument {@link AthenaTransport.cancel}
   * takes.
   */
  queryExecutionId: string;

  statementType: AthenaStatementType | null;

  /**
   * Rows the statement changed, or null when it changed nothing / said nothing.
   *
   * Deliberately not defaulted to zero: an `INSERT INTO` reports the count, a
   * `CREATE TABLE` reports none, and "created a table" is not "changed zero rows".
   */
  affectedRows: number | null;

  stats: AthenaExecutionStats;
}

/** Per-statement options. */
export interface AthenaQueryOptions {
  /**
   * Aborts the poll and the result read.
   *
   * The ONE deadline knob, deliberately: the service has no per-statement deadline
   * to set on submission, so there is nothing else to configure. The abort is not
   * merely a client concern, because the implementation owes the service a
   * cancellation on every exit path - abandoning the poll leaves the statement
   * running and scanning.
   *
   * A caller wanting a timeout composes `AbortSignal.timeout(ms)`; the
   * implementation reports that as a timeout rather than a cancellation, because
   * the signal - not the thrown value - is what knows which happened.
   */
  signal?: AbortSignal;

  /**
   * Called once with the statement's id, as soon as the service has accepted it
   * and before the answer is complete.
   *
   * The result carries the id too, but only when there IS a result. A caller that
   * needs to cancel a statement from somewhere else - a UI button, a component
   * unmount - has to learn the id while the statement is still running, and this
   * is the only moment that exists.
   */
  onQueryStarted?: (queryExecutionId: string) => void;
}

/** One database of the catalog, as the metadata API lists it. */
export interface AthenaDatabase {
  name: string;
}

/** One column of a table, as the catalog registered it. */
export interface AthenaColumn {
  name: string;
  /** The catalog's own spelling of the type: `string`, `bigint`, `array<string>`, `struct<...>`. */
  type: string;
}

/**
 * One table of one database, as the catalog registered it.
 *
 * `tableType` is carried VERBATIM rather than as a kind, because what the
 * catalog's spelling means is a provider decision (`objects.ts`) and not a wire
 * one: the metadata API hands back whatever string whoever registered the table
 * wrote there, and the provider owns the reading of it. Null when the catalog
 * recorded none.
 *
 * `partitionKeys` are the table's partition columns, which the catalog keeps
 * apart from the data columns and which a query addresses exactly like a column.
 * `parameters` is the catalog's free-form property bag, where crawlers and
 * engines leave statistics such as a row count; the provider reads the few keys
 * it knows and ignores the rest.
 */
export interface AthenaTable {
  name: string;
  tableType: string | null;
  columns: AthenaColumn[];
  partitionKeys: AthenaColumn[];
  parameters: Record<string, string>;
}

/**
 * What one table listing answered, and whether it stopped short.
 *
 * The metadata API pages fifty tables at a time, so a listing is a loop, and the
 * loop has a ceiling (`listTables`'s `limit`). `truncated` says the ceiling bit -
 * there were more tables than were read - so a caller can report a floor rather
 * than pass a cut off as the whole.
 */
export interface AthenaTableListing {
  tables: AthenaTable[];
  truncated: boolean;
}

/** What the connection's workgroup says about itself. */
export interface AthenaWorkgroupInfo {
  name: string;
  /** `ENABLED` or `DISABLED`, or null when the service did not say. */
  state: string | null;
  /** The engine the workgroup runs, e.g. `Athena engine version 3`. Null when unreported. */
  engineVersion: string | null;
  /** The workgroup's own result location, if it configures one. */
  outputLocation: string | null;
  /**
   * Whether the workgroup's settings override what a statement carries.
   *
   * Load-bearing for the connection's own `outputLocation`: when this is true the
   * service ignores the location a statement names and writes to the workgroup's,
   * so a connection that set one is not writing where it thinks it is.
   */
  enforcesConfiguration: boolean;
  /** The per-statement scan ceiling the workgroup enforces, in bytes, or null for none. */
  bytesScannedCutoff: number | null;
}

/**
 * One statement the workgroup recently ran, for the monitoring panels.
 *
 * `state` is the service's own word: `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`,
 * `CANCELLED`. `submittedAt` and `completedAt` are the service's clocks, and the
 * elapsed time between them is the only honest duration a client can report,
 * which is why both are carried rather than a difference measured here.
 */
export interface AthenaExecutionSummary {
  queryExecutionId: string;
  statement: string;
  state: string;
  database: string | null;
  workgroup: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  engineMs: number | null;
  queuedMs: number | null;
  scannedBytes: number | null;
}

/**
 * Why a statement or a request failed, in terms the provider maps onto this
 * repo's error classes without knowing anything about the SDK or the wire.
 *
 * Two sources feed this, and the implementation owes the distinction: a
 * statement the service ran and REFUSED reports its failure inside the job's
 * status, with the engine's own fault name at the head of the sentence; a request
 * the service refused before it became a statement - a credential it did not
 * accept, a workgroup that does not exist, a throttle - arrives as an exception
 * named by the service.
 */
export type AthenaErrorCategory =
  /** The statement is not valid for the engine's grammar. */
  | "syntax"
  /** The statement is valid but names a database, table, column or function that does not exist. */
  | "unknown-object"
  /** The grammar accepts it; this engine or this table format does not implement it. */
  | "unsupported"
  /** Credentials were absent, wrong, expired, or lack the permission. */
  | "auth"
  /** Nothing answered, or what answered was not the service. */
  | "unreachable"
  /** The caller aborted, or the statement was cancelled on the service. */
  | "cancelled"
  /** The poll outlived its deadline. */
  | "timeout"
  /** The service throttled the request or the workgroup refused the statement its resources. */
  | "resources"
  /** Reached, understood, and refused for a reason none of the above covers. */
  | "engine";

/**
 * A failure that crossed the seam.
 *
 * Carries the service's own wording verbatim, because rewriting it would throw
 * away the only text that locates the fault: a mistyped keyword answers
 * `SYNTAX_ERROR: line 1:1: mismatched input 'SELEKT'` and a missing table
 * `TABLE_NOT_FOUND: line 1:15: Table 'awsdatacatalog.db.t' does not exist`.
 *
 * `code` is the engine's stable fault name (`SYNTAX_ERROR`, `TABLE_NOT_FOUND`)
 * when the failure carried one, or the exception name the service answered with
 * (`AccessDeniedException`, `TooManyRequestsException`). It is DIAGNOSTIC: the
 * category is what a caller branches on.
 */
export class AthenaTransportError extends Error {
  constructor(
    readonly category: AthenaErrorCategory,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "AthenaTransportError";
    // Subclassing a builtin loses the prototype under a downlevel emit, which
    // would make every instanceof check in the provider quietly fall through.
    Object.setPrototypeOf(this, AthenaTransportError.prototype);
  }
}

/**
 * The seam itself.
 *
 * `cancel` is a method for the reason the header gives: on this service,
 * abandoning a poll does not stop the work, so terminating a statement is an
 * explicit act the seam has to be able to perform - both internally, on every
 * exit path of a statement it started, and on demand for a statement whose id a
 * caller learned through {@link AthenaQueryOptions.onQueryStarted} or read off the
 * sessions panel.
 *
 * The catalog reads are methods rather than statements because the service
 * publishes them through an API that costs no execution: a tree refresh that
 * ran `information_schema` statements would submit one job per read, wait on
 * each, and write each answer to S3.
 */
export interface AthenaTransport {
  /** Run one statement to completion and read its rows. */
  query(sql: string, options?: AthenaQueryOptions): Promise<AthenaQueryResult>;

  /**
   * Terminate a statement on the service.
   *
   * Forgiving by design, matching what the service does: stopping a statement
   * that has already finished is accepted rather than reported, so a caller may
   * cancel without first proving the statement is still running, and must not
   * read success here as proof that it was.
   */
  cancel(queryExecutionId: string, signal?: AbortSignal): Promise<void>;

  /** Every database of the connection's catalog. */
  listDatabases(): Promise<AthenaDatabase[]>;

  /**
   * The tables of one database, columns included, up to `limit` of them.
   *
   * The limit is a ceiling on the loop and never a page size: the listing reads
   * page after page until it has `limit` tables or the database has no more, and
   * reports which of the two stopped it.
   */
  listTables(database: string, limit: number): Promise<AthenaTableListing>;

  /** One table of one database, or null when the catalog holds no table of that name. */
  describeTable(database: string, name: string): Promise<AthenaTable | null>;

  /** What the connection's workgroup says about itself. */
  describeWorkgroup(): Promise<AthenaWorkgroupInfo>;

  /**
   * The statements the workgroup ran most recently, newest first, at most `limit`
   * of them.
   *
   * A bounded window rather than a history: the service lists ids newest first
   * and describes them in batches, and this is the only per-statement record the
   * service keeps outside CloudTrail.
   */
  listExecutions(limit: number): Promise<AthenaExecutionSummary[]>;

  close(): Promise<void>;
}
