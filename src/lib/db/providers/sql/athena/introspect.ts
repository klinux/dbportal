/**
 * Athena monitoring reads
 *
 * Every read the provider makes that is neither the user's own statement nor the
 * object surface lives here, and all of them go through the transport seam, so
 * this file names nothing from the SDK. It owns no transport either: each function
 * takes one, which is what lets the provider hand it the service and a test hand
 * it four summaries.
 *
 * Athena is a SERVERLESS query service, and that single fact decides most of what
 * follows. There is no process to report an uptime for, no connection to count,
 * no buffer pool, no lock and no cache to publish a ratio for. What the service
 * DOES publish, and what an Athena user actually watches, is the per-statement
 * record: how long each statement ran, how long it queued, and above all how
 * many bytes it scanned, because that number is the bill. The panels below are
 * built from that record and say "not measured" everywhere else, in the words
 * `sqlite.ts`, `oracle.ts` and `trino/introspect.ts` already use for it.
 *
 * The reads split into two groups with different failure rules:
 *
 * - The WORKGROUP and the EXECUTION HISTORY are read with permissions a
 *   query-only IAM policy may well not grant (`athena:GetWorkGroup`,
 *   `athena:ListQueryExecutions`, `athena:BatchGetQueryExecution`). Their
 *   failures DEGRADE to nothing: one missing panel is the right price, and a
 *   dashboard that fails because a policy withheld the history is not.
 * - The TABLE STATISTICS come from the catalog's own property bag, through the
 *   same listing the schema tree reads, so a refusal there is the user's own
 *   configuration and PROPAGATES the way the tree's does.
 */

import type {
  ActiveSession,
  ActiveSessionDetails,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  PerformanceMetrics,
  SlowQuery,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { formatBytes, formatDuration } from "@/lib/db/utils/pool-manager";
import {
  type AthenaExecutionSummary,
  type AthenaTable,
  type AthenaTransport,
  AthenaTransportError,
  type AthenaWorkgroupInfo,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/** What a panel prints for something the service did not tell us. */
export const ATHENA_UNKNOWN_TEXT = "unknown";

/**
 * What `HealthInfo.cacheHitRatio`, `DatabaseOverview.uptime` and
 * `DatabaseOverview.databaseSize` say on Athena.
 *
 * Strings, so they can say "not measured" - which is the truth rather than a
 * hedge: a serverless service has no uptime, caches nothing this client can see,
 * and stores nothing itself.
 */
export const ATHENA_UNAVAILABLE_TEXT = "N/A";

/** Row cap for the sessions panel when the caller names none. */
export const ATHENA_DEFAULT_SESSION_LIMIT = 50;

/** Row cap for the slow-query panel when the caller names none. */
export const ATHENA_DEFAULT_SLOW_QUERY_LIMIT = 20;

/** Row cap for the sessions and slow queries the health summary embeds. */
const ATHENA_HEALTH_LIMIT = 10;

/**
 * How far back the execution history is read for one panel.
 *
 * The service lists ids newest first, fifty per page, and describes them fifty
 * per call, so this is four listing pages and four descriptions - enough to fill
 * a slow-query panel on a busy workgroup, and bounded so a workgroup with a
 * million statements behind it does not turn one panel open into a history crawl.
 */
export const ATHENA_HISTORY_WINDOW = 200;

/**
 * How many tables the statistics pass will read in one listing.
 *
 * The same ceiling the schema tree uses, so the two never disagree about what a
 * database holds; a listing the ceiling cut is REFUSED for statistics rather than
 * sampled, for the reason `trino/introspect.ts` records (#515): 25 rows read as a
 * count and not as a sample, and `TableStats[]` has nowhere to say which it was.
 */
export const ATHENA_MAX_STATS_TABLES = 10_000;

/** The states a statement is still in flight in. */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set(["QUEUED", "RUNNING"]);

/** The one terminal state whose timings describe a statement that ran to completion. */
const SUCCEEDED_STATE = "SUCCEEDED";

/**
 * The catalog property keys that carry a row count and a byte size.
 *
 * Two spellings each, because two writers exist: a Glue crawler writes
 * `recordCount` and `sizeKey`, a Hive-style engine (Spark, EMR, Athena's own CTAS)
 * writes `numRows` and `totalSize`. Read in that order; the first present wins.
 */
const ROW_COUNT_KEYS = ["numRows", "recordCount"] as const;
const SIZE_KEYS = ["totalSize", "sizeKey"] as const;

/**
 * The failures that mean "this surface is not available to this principal"
 * rather than "the read went wrong". Every other failure propagates - a throttle
 * or an unreachable endpoint hidden behind an empty panel is hidden forever.
 */
const UNAVAILABLE_CATEGORIES: ReadonlySet<string> = new Set(["auth", "unknown-object"]);

// ============================================================================
// Types
// ============================================================================

/**
 * The part of the seam these reads use.
 *
 * Narrower than `AthenaTransport` on purpose: this module never opens, cancels or
 * closes anything, so taking the whole transport would claim a lifecycle it does
 * not have.
 */
export type AthenaMonitoringRunner = Pick<AthenaTransport, "describeWorkgroup" | "listExecutions" | "listTables">;

/**
 * What a table-statistics pass found, and why it found nothing when it found nothing.
 *
 * The panel has three empty readings and only ONE of them is a measurement: a
 * database that really holds no table. The other two - a database holding more
 * tables than one listing reads, and a database full of tables none of which
 * carries a count - are refusals, and `MonitoringData` requires those to be reported
 * as an ABSENT panel carrying the reason rather than as an empty one (#477).
 */
export interface AthenaTableStatsReading {
  readonly tables: TableStats[];
  readonly refusal?: string;
}

// ============================================================================
// Value readers
// ============================================================================

/** A non-negative integer the catalog wrote as text, or undefined for anything else. */
function readCatalogNumber(parameters: Readonly<Record<string, string>>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const text = parameters[key];
    if (text === undefined || !/^\d+$/.test(text)) continue;
    const parsed = Number(text);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/** A duration that is never negative: a clock read backwards is worse than a zero. */
function nonNegative(value: number | null): number {
  return value === null || value < 0 ? 0 : value;
}

/** A row cap that is always a positive integer. */
function rowLimit(limit: number | undefined, fallback: number): number {
  const requested = Math.trunc(limit ?? fallback);
  return requested > 0 ? requested : fallback;
}

// ============================================================================
// Reads
// ============================================================================

/**
 * One read whose failure costs a panel rather than the session, so it degrades to
 * the fallback when the surface is not available to this principal.
 */
async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AthenaTransportError && UNAVAILABLE_CATEGORIES.has(error.category)) return fallback;
    throw error;
  }
}

/** The recent history, or nothing when the policy withholds it. */
function recentExecutions(runner: AthenaMonitoringRunner): Promise<AthenaExecutionSummary[]> {
  return optional(() => runner.listExecutions(ATHENA_HISTORY_WINDOW), []);
}

/** The workgroup's own description, or nothing when the policy withholds it. */
function workgroup(runner: AthenaMonitoringRunner): Promise<AthenaWorkgroupInfo | null> {
  return optional(() => runner.describeWorkgroup(), null);
}

/** The statement's wall-clock span between the service's two timestamps, when it has both. */
function spanMs(summary: AthenaExecutionSummary, now: Date): number {
  const started = summary.submittedAt?.getTime();
  if (started === undefined) return 0;
  return nonNegative((summary.completedAt ?? now).getTime() - started);
}

// ============================================================================
// Monitoring
// ============================================================================

/**
 * What the workgroup is, and how much it is doing.
 *
 * Two independent reads, each optional: the workgroup description and the recent
 * history are separately grantable, and losing one must not cost the other. The
 * table count is the pinned database's, from the same listing the tree reads, and
 * a database the connection does not pin has no count to show.
 */
export async function getOverview(
  runner: AthenaMonitoringRunner,
  database: string | undefined,
): Promise<DatabaseOverview> {
  const [info, history, listing] = await Promise.all([
    workgroup(runner),
    recentExecutions(runner),
    database === undefined ? Promise.resolve(null) : runner.listTables(database, ATHENA_MAX_STATS_TABLES),
  ]);

  return {
    // The engine version the workgroup runs, which is the only version the service
    // publishes: there is no server to ask.
    version: info?.engineVersion ?? ATHENA_UNKNOWN_TEXT,
    // Nothing is up or down: the service is serverless, so an uptime is not a
    // reading that could exist, and `startTime` stays absent for the same reason.
    uptime: ATHENA_UNAVAILABLE_TEXT,
    // A statement in flight is the only occupied thing the service has; it holds
    // no session object anywhere.
    activeConnections: history.filter((summary) => IN_FLIGHT_STATES.has(summary.state)).length,
    // Zero means "no limit published", the encoding `mssql.ts` and `trino` use: the
    // service's concurrency quota is an account setting no API call answers.
    maxConnections: 0,
    // The bytes live in S3 under whatever prefixes the tables point at, and the
    // catalog publishes no total. `databaseSizeBytes` is not written at all, the
    // shape `cassandra/introspect.ts` uses: the key is optional precisely so the
    // absence can be said.
    databaseSize: ATHENA_UNAVAILABLE_TEXT,
    tableCount: listing?.tables.length ?? 0,
    // No index object exists anywhere in the model.
    indexCount: 0,
  };
}

/**
 * Empty, and every absence is a different impossibility.
 *
 * The service runs no transactions, holds no buffer pool, takes no locks, writes
 * no checkpoints and publishes no cache ratio; a zero in any of them would read as
 * a MEASUREMENT of zero, and `cacheHitRatio` in particular is scored
 * `direction: "below"` with `critical: 80`, so a "neutral" 0 would paint every
 * healthy workgroup red. `queriesPerSecond` could be derived from the history
 * window, and is deliberately not: the window is bounded by count and not by
 * time, so the rate would depend on how busy the workgroup happened to be.
 */
export function getPerformanceMetrics(): Promise<PerformanceMetrics> {
  return Promise.resolve({});
}

/**
 * The slowest completed statements in the recent history, slowest first.
 *
 * `calls: 1` on every row, and that is the honest reading rather than a
 * placeholder: the history records one row per EXECUTION, so there is no
 * aggregation to report and `totalTime` and `avgTime` are necessarily the same
 * number. `rows` is 0 for a harder reason - the service records no row count for
 * a statement, and `SlowQueryStats.rows` is required, so this is the one field
 * here that cannot say "not reported". The engine time is what is ranked, not the
 * wall clock, because a statement that sat in the queue was not slow to execute.
 */
export async function getSlowQueries(
  runner: AthenaMonitoringRunner,
  options: { limit?: number } = {},
): Promise<SlowQueryStats[]> {
  const limit = rowLimit(options.limit, ATHENA_DEFAULT_SLOW_QUERY_LIMIT);
  const history = await recentExecutions(runner);

  return history
    .filter((summary) => summary.state === SUCCEEDED_STATE && summary.engineMs !== null)
    .sort((left, right) => (right.engineMs ?? 0) - (left.engineMs ?? 0))
    .slice(0, limit)
    .map((summary) => {
      const engineMs = nonNegative(summary.engineMs);
      return {
        queryId: summary.queryExecutionId,
        query: summary.statement,
        calls: 1,
        totalTime: engineMs,
        avgTime: engineMs,
        rows: 0,
      };
    });
}

/**
 * The statements in flight, described as sessions, oldest first.
 *
 * `user` is blank because the service does not record it per statement: which IAM
 * principal submitted a statement is a CloudTrail fact, not a history one, and the
 * connection's own key would credit every other client's statement with an
 * identity that may never have touched it. The elapsed time is measured against
 * THIS clock, which is stated rather than hidden: the service reports a submission
 * instant and no "now", so the difference is the only reading available.
 */
export async function getActiveSessions(
  runner: AthenaMonitoringRunner,
  options: { limit?: number } = {},
  now: Date = new Date(),
): Promise<ActiveSessionDetails[]> {
  const limit = rowLimit(options.limit, ATHENA_DEFAULT_SESSION_LIMIT);
  const history = await recentExecutions(runner);

  return history
    .filter((summary) => IN_FLIGHT_STATES.has(summary.state))
    .sort((left, right) => (left.submittedAt?.getTime() ?? 0) - (right.submittedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map((summary) => {
      const durationMs = spanMs(summary, now);
      return {
        pid: summary.queryExecutionId,
        user: "",
        database: summary.database ?? "",
        // The workgroup is the nearest thing to an application name the service
        // records: it is what an operator routes and bills by.
        ...(summary.workgroup === null ? {} : { applicationName: summary.workgroup }),
        state: summary.state,
        query: summary.statement,
        ...(summary.submittedAt === null ? {} : { queryStart: summary.submittedAt }),
        duration: formatDuration(durationMs),
        durationMs,
      };
    });
}

/** Why a database too large for one listing is refused rather than sampled. */
function tableStatsScopeRefusal(database: string): string {
  return `Database "${database}" holds more than ${ATHENA_MAX_STATS_TABLES} tables, more than one listing reads. The first ${ATHENA_MAX_STATS_TABLES} are not offered as the answer, because ${ATHENA_MAX_STATS_TABLES} rows read as the database's table count rather than as the sample they would be. The tables themselves are in the schema tree.`;
}

/** Why a database full of tables produced no statistics row. */
function tableStatsRefusal(database: string, examined: number): string {
  return `None of the ${examined} tables in database "${database}" carries a row count in the catalog. Athena computes no statistics of its own for Hive tables: a row count appears in a table's properties only when a Glue crawler (recordCount) or an engine that writes Hive statistics (numRows) put it there. So these figures are not knowable here; the tables themselves are in the schema tree.`;
}

/**
 * Row counts and sizes from the catalog's own property bag, one listing for the
 * whole database.
 *
 * A table whose properties carry NO row count is left out entirely rather than
 * reported as zero: `TableStats.rowCount` is a required number with no way to say
 * "unknown", and "0 rows" is a claim nothing made about a table nobody crawled.
 * Where that leaves NOTHING at all the panel says so in words instead of rendering
 * an empty table (`AthenaTableStatsReading`). A size is carried only when the
 * catalog wrote one, in the optional fields the type has for exactly that.
 *
 * `options.schema` narrows to one database; without it the connection's pinned
 * database is the scope, and a connection pinning none has no scope to read.
 */
export async function getTableStats(
  runner: AthenaMonitoringRunner,
  pinnedDatabase: string | undefined,
  options: { schema?: string } = {},
): Promise<AthenaTableStatsReading> {
  const database = options.schema ?? pinnedDatabase;
  if (database === undefined) {
    return {
      tables: [],
      refusal:
        "This connection pins no Athena database, so there is no scope to read statistics for. Set the database on the connection, or ask for one schema.",
    };
  }

  const listing = await runner.listTables(database, ATHENA_MAX_STATS_TABLES);
  if (listing.truncated) return { tables: [], refusal: tableStatsScopeRefusal(database) };

  const tables = listing.tables.flatMap((table: AthenaTable): TableStats[] => {
    const rowCount = readCatalogNumber(table.parameters, ROW_COUNT_KEYS);
    if (rowCount === undefined) return [];
    const sizeBytes = readCatalogNumber(table.parameters, SIZE_KEYS);
    return [
      {
        schemaName: database,
        tableName: table.name,
        rowCount,
        ...(sizeBytes === undefined ? {} : { tableSize: formatBytes(sizeBytes), tableSizeBytes: sizeBytes }),
        // The same number, not that number plus an index total: there are no index
        // objects to add, so a separate `indexSize` would measure something that does
        // not exist and stays absent.
        totalSize: sizeBytes === undefined ? ATHENA_UNAVAILABLE_TEXT : formatBytes(sizeBytes),
        totalSizeBytes: sizeBytes ?? 0,
      },
    ];
  });

  // Tables were examined and none of them answered: a refusal, not an empty
  // database. A database that genuinely holds no table keeps its empty array,
  // which IS a measurement and renders as one.
  if (tables.length === 0 && listing.tables.length > 0) {
    return { tables, refusal: tableStatsRefusal(database, listing.tables.length) };
  }
  return { tables };
}

/**
 * Empty, and empty because no index OBJECT exists rather than because none was
 * found. No call is made to discover that, which is why this takes no runner.
 */
export function getIndexStats(): IndexStats[] {
  return [];
}

/**
 * Empty: the catalog publishes no location or size per database through this
 * API, and a row per table would repeat the tables panel under another name.
 * The bytes live in S3 under the prefixes each table's own definition names, and
 * the storage that matters to a bill - what each statement scanned - is on the
 * statement's own record.
 */
export function getStorageStats(): StorageStats[] {
  return [];
}

/** The narrower shape the health summary embeds. */
function toSlowQuery(stats: SlowQueryStats): SlowQuery {
  return { query: stats.query, calls: stats.calls, avgTime: formatDuration(stats.avgTime) };
}

/** The narrower shape the health summary embeds. */
function toActiveSession(session: ActiveSessionDetails): ActiveSession {
  return {
    pid: session.pid,
    user: session.user,
    database: session.database,
    state: session.state,
    query: session.query,
    duration: session.duration,
  };
}

/** The health summary, composed from the reads that have a source. */
export async function getHealth(runner: AthenaMonitoringRunner, database: string | undefined): Promise<HealthInfo> {
  const [overview, slow, sessions] = await Promise.all([
    getOverview(runner, database),
    getSlowQueries(runner, { limit: ATHENA_HEALTH_LIMIT }),
    getActiveSessions(runner, { limit: ATHENA_HEALTH_LIMIT }),
  ]);

  return {
    activeConnections: overview.activeConnections,
    databaseSize: overview.databaseSize,
    cacheHitRatio: ATHENA_UNAVAILABLE_TEXT,
    slowQueries: slow.map(toSlowQuery),
    activeSessions: sessions.map(toActiveSession),
  };
}
