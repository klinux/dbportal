/**
 * Amazon Athena Database Provider
 *
 * Trino-family SQL over a serverless query service, reached through the AWS SDK.
 * Every statement, catalog read and metric goes through the `AthenaTransport`
 * seam, so this file never names a command, a wire field or a pagination token,
 * and `seam-guard.test.ts` fails the build if it starts to. The SDK lives in
 * `sdk-transport.ts`; the object surface's pure derivations in `objects.ts`; the
 * monitoring reads in `introspect.ts`; the connection's settings in `settings.ts`.
 *
 * It extends `SQLBaseProvider` because the dialect is standard on the points the
 * shared helpers care about - double-quoted identifiers and `information_schema`
 * spelled the ANSI way - which is the case `docs/ADDING_A_PROVIDER.md` names Trino
 * for. `prepareQuery()` is overridden for the one clause-order trap the two engines
 * share.
 *
 * Five service facts shape almost everything here:
 *
 * - THERE IS NO SERVER. A connection names a region, a workgroup and an S3 prefix;
 *   `connect()` proves the credentials and the workgroup with the cheapest call that
 *   costs no job, and refuses on the spot a workgroup that is disabled or a
 *   connection that would have nowhere to write results.
 * - EVERY STATEMENT IS A BILLED JOB THAT WRITES TO S3. The catalog is therefore read
 *   through the service's metadata API and never with `information_schema`
 *   statements: one tree refresh would otherwise be five jobs and five S3 objects.
 *   One listing per database is cached briefly, because the tree asks four
 *   questions about the same database in a row.
 * - THE CATALOG DECLARES NO KEY AND NO INDEX. Glue records columns and partition
 *   keys and nothing else, so `declaresForeignKeys` is false and the inline row
 *   editor - which needs a primary key to build a `WHERE` that identifies one row -
 *   is switched off rather than offered as a control that can only rewrite every
 *   matching row.
 * - `CREATE TABLE` NEEDS WHAT THE MODAL CANNOT ASK. A Hive table needs a `LOCATION`
 *   and an Iceberg table needs `TBLPROPERTIES ('table_type' = 'ICEBERG')`, and the
 *   shared modal builds a bare column list, so `supportsCreateTable` is false.
 * - ABANDONING A STATEMENT DOES NOT STOP IT. The job runs on and scans on, so
 *   `cancelQuery()` exists, every timeout stops the job it abandons, and the id it
 *   needs is learned while the statement is still in flight.
 */

import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { callerBoundTruncationReason, containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import {
  type ActiveSessionDetails,
  type Container,
  type DatabaseConnection,
  type DatabaseObject,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type KindCount,
  type MaintenanceResult,
  type MaintenanceType,
  type ObjectDetail,
  type ObjectDetailBatch,
  type PerformanceMetrics,
  type PreparedQuery,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderOptions,
  type QueryPrepareOptions,
  type QueryResult,
  type SlowQueryStats,
  type StorageStats,
  type TableStats,
} from "@/lib/db/types";
import { offsetBeforeLimit } from "../offset-before-limit";
import { SQLBaseProvider } from "../sql-base";
import {
  type AthenaMonitoringRunner,
  getActiveSessions as readActiveSessions,
  getHealth as readHealth,
  getIndexStats as readIndexStats,
  getOverview as readOverview,
  getPerformanceMetrics as readPerformanceMetrics,
  getSlowQueries as readSlowQueries,
  getStorageStats as readStorageStats,
  getTableStats as readTableStats,
} from "./introspect";
import { containerRead, countsFrom, kindOf, listedObject, objectDetailFromTable, objectRead } from "./objects";
import { AthenaSdkTransport, type AthenaSdkTransportDeps } from "./sdk-transport";
import { type AthenaSettings, AthenaSettingsError, readAthenaSettings } from "./settings";
import {
  ATHENA_DISPLAY_NAME,
  type AthenaQueryResult,
  type AthenaTable,
  type AthenaTableListing,
  type AthenaTransport,
  AthenaTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The one statement the connect probe falls back to.
 *
 * Sent only when the workgroup description was denied by POLICY rather than by
 * a bad credential: a query-only IAM policy may withhold `athena:GetWorkGroup`
 * while granting `athena:StartQueryExecution`, and refusing such a connection
 * would refuse one that runs every statement the user came for. It costs one job
 * and one S3 object, which is why it is the fallback and not the probe.
 */
const CONNECT_PROBE_SQL = "SELECT 1";

/** The exception name that means "this principal lacks the permission", as opposed to "this key is wrong". */
const PERMISSION_DENIED_CODE = "AccessDeniedException";

/** The statements that change what the schema tree would show. */
const SCHEMA_REFRESH_PATTERN = "\\b(CREATE|DROP|ALTER|MSCK)\\b";

/**
 * How many tables one database listing reads before it is reported as a floor.
 *
 * The metadata API pages fifty at a time, so this is two hundred calls at most
 * for one folder, and past it the count is carried as `{ count, sampledFrom }`
 * rather than as a total (#789). The same ceiling bounds the statistics pass.
 */
const OBJECT_LISTING_CEILING = 10_000;

/**
 * How long one database's listing is reused.
 *
 * The tree asks the same database four questions in a row - count, list tables,
 * list views, describe - and each would be a full page walk. Thirty seconds is
 * long enough to serve one refresh from one walk and short enough that a table
 * created in the console appears on the next; a DDL statement run through this
 * provider clears the cache on its own.
 */
const LISTING_TTL_MS = 30_000;

/** The shape of a query execution id, which is what `kill` takes. */
const QUERY_EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The neutral transport result as the grid's row contract.
 *
 * The service's own engine time is what is reported, and only when it reported
 * one: a number measured in this process would include the poll interval, which
 * says nothing about the statement.
 */
function toQueryResult(result: AthenaQueryResult, fallbackMs: number): QueryResult {
  const columnTypes = result.columnTypes ?? {};
  return {
    rows: result.rows,
    fields: result.fieldNames ?? [],
    rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0),
    executionTime: result.stats.engineMs ?? fallbackMs,
    ...(Object.keys(columnTypes).length > 0 ? { columnTypes } : {}),
  };
}

/** What this provider may be handed beside its configuration, which is only what its tests need. */
export type AthenaProviderDeps = AthenaSdkTransportDeps;

// ============================================================================
// Athena Provider
// ============================================================================

export class AthenaProvider extends SQLBaseProvider {
  private transport: AthenaTransport | null = null;
  private readonly settings: AthenaSettings;
  private readonly deps: AthenaProviderDeps;

  /** One database's listing, read once and reused for a short while. */
  private readonly listings = new Map<string, { at: number; listing: AthenaTableListing }>();

  /**
   * The service's id for each statement this provider started, keyed by the
   * CLIENT's own tracking token: the editor generates a token before it sends
   * anything, while the service's id exists only once the statement is accepted.
   */
  private readonly runningQueryIds = new Map<string, string>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, deps: AthenaProviderDeps = {}) {
    super(config, options);
    this.deps = deps;
    this.validate();
    // `validate()` has just proven the settings readable; this is the same read.
    this.settings = readAthenaSettings(config);
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // The engine answers `EXPLAIN (FORMAT JSON)` in Trino's own shape, but that
      // has not been measured against the service, and a flag that is true without
      // a strategy behind it is a dead button (docs/ADDING_A_PROVIDER.md, capability
      // honesty). Off until a live pass settles it.
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      // A Hive table needs LOCATION and an Iceberg table needs TBLPROPERTIES, and the
      // modal builds a bare column list; see the header.
      supportsCreateTable: false,
      // No key exists in the catalog's model, so no column identifies one row.
      supportsInlineRowEdit: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      // One operation, and it is a real one: stopping a statement by its id. The
      // catalog holds no statistics of its own to update and no storage of its own to
      // reclaim; OPTIMIZE and VACUUM exist for Iceberg tables only, and a control that
      // fails on every Hive table is worse than none.
      maintenanceOperations: ["kill"],
      maintenanceOperationSpecs: {
        kill: { label: "Stop Query", perEntity: false, global: false },
      },
      supportsConnectionString: false,
      // No port: the SDK derives the endpoint from the region.
      defaultPort: null,
      identifierQuoting: "double",
      // A Trino-family grammar: a trailing `;` is not in it, so the generators must
      // not emit one. The transport drops a lone one a caller wrote out of habit.
      statementTerminator: "none",
      schemaRefreshPattern: SCHEMA_REFRESH_PATTERN,
      // ONE level, and the engine's own word for it is "database": a Glue Data Catalog
      // holds databases, and a database holds tables and views. The catalog itself is
      // pinned by the connection and reached in SQL by a qualified name, so it is not a
      // level anybody browses.
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
      objectKinds: [
        // A row write reaches whatever the table format allows: INSERT INTO on a Hive
        // table appends files, and Iceberg tables take UPDATE and DELETE too. The
        // format's own refusal is the better message for the case it cannot.
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      ],
    };
  }

  /**
   * Table and row are the engine's own words, so only the maintenance copy and the
   * slow-query empty state are rewritten: the inherited copy would promise a panel
   * that updates planner statistics and reclaims space, neither of which this
   * service does.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Table Statistics",
      vacuumAction: "Reclaim Space",
      analyzeGlobalLabel: "Table Statistics",
      analyzeGlobalTitle: "Statistics Belong to the Catalog",
      analyzeGlobalDesc:
        "Athena reads the row counts a Glue crawler or a writing engine left in the catalog and computes none of its own for Hive tables. Nothing runs from here.",
      vacuumGlobalLabel: "Reclaim Space",
      vacuumGlobalTitle: "Athena Owns No Storage",
      vacuumGlobalDesc:
        "The bytes live in S3 under the locations each table names. Reclaiming them is an S3 lifecycle or an Iceberg VACUUM run in the editor. Nothing runs from here.",
      slowQueriesEmptyState:
        "Query stats come from the workgroup's recent execution history, which holds the statements the service still lists.",
    };
  }

  /** The inherited limiter puts the clause in the order the engine refuses; see `offset-before-limit.ts`. */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    return offsetBeforeLimit(query, super.prepareQuery(query, options));
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  /** Every setting the service would refuse later is refused here, with the field named. */
  public override validate(): void {
    super.validate();
    try {
      readAthenaSettings(this.config);
    } catch (error) {
      if (error instanceof AthenaSettingsError) throw new DatabaseConfigError(error.message, this.type);
      throw error;
    }
  }

  /**
   * Prove the credentials and the workgroup without running a job.
   *
   * The workgroup description is the probe: it fails fast on a wrong region, a
   * wrong key, a missing workgroup and an unreachable endpoint, and its answer
   * settles two things a first statement would otherwise fail on with a worse
   * sentence - a disabled workgroup, and a connection with nowhere to write
   * results. Denied by POLICY, the probe falls back to the one statement.
   */
  public async connect(): Promise<void> {
    const transport = new AthenaSdkTransport(this.settings, this.deps);
    try {
      await this.probe(transport);
    } catch (error) {
      const failure = this.describeConnectFailure(error);
      this.setError(failure);
      throw failure;
    }

    this.transport = transport;
    this.setConnected(true);
  }

  private async probe(transport: AthenaTransport): Promise<void> {
    let workgroup;
    try {
      workgroup = await transport.describeWorkgroup();
    } catch (error) {
      if (!(error instanceof AthenaTransportError) || error.code !== PERMISSION_DENIED_CODE) throw error;
      await transport.query(CONNECT_PROBE_SQL, { signal: AbortSignal.timeout(this.queryTimeout) });
      return;
    }

    if (workgroup.state !== null && workgroup.state !== "ENABLED") {
      throw new DatabaseConfigError(
        `Workgroup "${workgroup.name}" is ${workgroup.state.toLowerCase()}, so no statement can run in it. Enable it, or name another workgroup on the connection.`,
        this.type,
      );
    }
    if (this.settings.outputLocation === undefined && workgroup.outputLocation === null) {
      throw new DatabaseConfigError(
        `Workgroup "${workgroup.name}" configures no result location and the connection names none, so the service would have nowhere to write a result. Set Output Location on the connection (s3://bucket/prefix/), or configure one on the workgroup.`,
        this.type,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.listings.clear();
    this.runningQueryIds.clear();
    this.setConnected(false);
  }

  private describeConnectFailure(error: unknown): Error {
    if (error instanceof DatabaseConfigError) return error;
    const mapped = this.mapAthenaError(error);
    // A refused credential is not a connectivity problem, and saying so would send
    // the user to check their region.
    if (mapped instanceof AuthenticationError) return mapped;

    return new ConnectionError(`Failed to connect to ${ATHENA_DISPLAY_NAME}: ${mapped.message}`, this.type);
  }

  private requireTransport(): AthenaTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false), so a
    // connected provider always has one.
    return this.transport!;
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  /**
   * One statement.
   *
   * Positional parameters are REFUSED rather than interpolated. The service does
   * bind them, as execution parameters on the submission, but their quoting rules
   * are the service's own and have not been measured here; running the statement
   * with its placeholders unbound, or splicing the values into the SQL, are both
   * worse than saying so.
   *
   * The deadline is the connection's query timeout, and when it fires the job is
   * STOPPED rather than abandoned: a serverless statement left running is billed
   * for every byte it goes on to scan.
   */
  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    const transport = this.requireTransport();
    if (params !== undefined && params.length > 0) {
      throw new QueryError(
        `${ATHENA_DISPLAY_NAME} binds parameters as execution parameters on the submission, which this client does not send, so positional parameters cannot be used here`,
        this.type,
        sql,
      );
    }

    return this.trackQuery(async () => {
      try {
        const { result, executionTime } = await this.measureExecution(() =>
          transport.query(sql, {
            signal: AbortSignal.timeout(this.queryTimeout),
            ...(queryId === undefined ? {} : { onQueryStarted: (id: string) => this.runningQueryIds.set(queryId, id) }),
          }),
        );
        // A statement that changed the catalog makes every cached listing stale.
        if (result.statementType === "DDL") this.listings.clear();
        return toQueryResult(result, executionTime);
      } catch (error) {
        throw this.mapAthenaError(error, sql);
      } finally {
        if (queryId !== undefined) this.runningQueryIds.delete(queryId);
      }
    });
  }

  /**
   * Stop a statement this provider started, named by the CLIENT's token.
   *
   * `false` means nothing was ever recorded under this token. `true` means the
   * service ACCEPTED the stop - not that the statement had not already finished,
   * which the service does not distinguish. A failure is swallowed to `false`
   * rather than thrown, matching `postgres.ts`: this is called from a UI affordance
   * whose whole purpose is to stop something.
   */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const queryExecutionId = this.runningQueryIds.get(queryId);
    if (queryExecutionId === undefined || this.transport === null) return false;

    try {
      await this.transport.cancel(queryExecutionId);
      return true;
    } catch (error) {
      this.logError("cancelQuery", error);
      return false;
    }
  }

  /**
   * Normalized transport failure -> the provider error vocabulary, keyed on the
   * CATEGORY the seam reported and never on anything the SDK threw.
   *
   * Anything that is not a transport failure goes to the shared message-based
   * mapping: a bug in this file's own mapping is not a database error and must not
   * be dressed as one.
   */
  private mapAthenaError(error: unknown, sql?: string): Error {
    if (!(error instanceof AthenaTransportError)) return this.mapError(error, sql);

    switch (error.category) {
      case "auth":
        return new AuthenticationError(error.message, this.type);
      case "unreachable":
        return new ConnectionError(error.message, this.type, this.settings.region);
      case "timeout":
        return new TimeoutError(error.message, this.type, this.queryTimeout, sql);
      case "cancelled":
        return new QueryCancelledError(error.message, this.type, sql);
      default:
        // `syntax`, `unknown-object`, `unsupported`, `resources` and `engine` all
        // describe a statement the service read and refused, and its own wording is
        // the most useful thing that can be shown for any of them.
        return new QueryError(error.message, this.type, sql);
    }
  }

  /** Run a catalog or monitoring read whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapAthenaError(error);
    }
  }

  // ==========================================================================
  // The object surface (#789)
  // ==========================================================================

  /**
   * One database's listing, from the cache while it is fresh.
   *
   * Always read at the ceiling, so one walk serves every question the tree asks
   * about the database; a caller wanting fewer takes a prefix of it below.
   */
  private async listing(database: string): Promise<AthenaTableListing> {
    const cached = this.listings.get(database);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < LISTING_TTL_MS) return cached.listing;

    const listing = await this.guarded(() => this.requireTransport().listTables(database, OBJECT_LISTING_CEILING));
    this.listings.set(database, { at: now, listing });
    return listing;
  }

  /** The part of the seam the monitoring reads take, with the listing served from the cache. */
  private monitoringRunner(): AthenaMonitoringRunner {
    const transport = this.requireTransport();
    return {
      describeWorkgroup: () => transport.describeWorkgroup(),
      listExecutions: (limit) => transport.listExecutions(limit),
      listTables: async (database, limit) => {
        const { tables, truncated } = await this.listing(database);
        return { tables: tables.slice(0, limit), truncated: truncated || tables.length > limit };
      },
    };
  }

  /**
   * The containers at `parent`: every database of the catalog, with the connection's
   * own marked. Below the one declared level the answer is `[]` rather than a
   * refusal, because "nothing nests under a database" is a true statement about the
   * engine and not a caller mistake.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const level = (parent ?? []).length;
    if (level >= containerDepth(this.getCapabilities())) return [];

    const databases = await this.guarded(() => this.requireTransport().listDatabases());
    return databases.map(({ name }) => ({
      path: [name],
      name,
      level,
      isSessionDefault: name === this.settings.database,
    }));
  }

  /**
   * How many objects of each declared kind one database holds - a total, or a FLOOR
   * when the listing stopped at the ceiling, carried as `{ count, sampledFrom }` so
   * the tree badges it `10,000+` rather than `10,000` (#789).
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const capabilities = this.getCapabilities();
    const database = containerRead(capabilities, container);
    const { tables, truncated } = await this.listing(database);
    return countsFrom(declaredKinds(capabilities), tables, truncated ? OBJECT_LISTING_CEILING : null);
  }

  /** The objects of one kind in one database, names only, in code-point order of path. */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const capabilities = this.getCapabilities();
    const database = containerRead(capabilities, container);
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`${ATHENA_DISPLAY_NAME} declares no object kind "${kind}"`, this.type);
    }

    const { tables } = await this.listing(database);
    return tables
      .filter((table) => kindOf(table) === kind)
      .map((table) => listedObject(capabilities, database, table))
      .sort((left, right) => comparePaths(left.path, right.path));
  }

  /**
   * Columns for one object of one KIND, from the catalog's own entry for it.
   *
   * The kind decides the read and the entry's own type is checked against it: a
   * table asked for as a view is a caller holding a stale tree, and answering the
   * columns anyway would let the tree draw one object under two folders.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`${ATHENA_DISPLAY_NAME} declares no object kind "${kind}"`, this.type);
    }

    const { database, name } = objectRead(capabilities, spec, path);
    const table = await this.guarded(() => this.requireTransport().describeTable(database, name));
    if (table === null) {
      throw new QueryError(`No ${spec.label.toLowerCase()} "${name}" in database "${database}"`, this.type);
    }
    if (kindOf(table) !== kind) {
      throw new QueryError(
        `"${name}" in database "${database}" is a ${kindOf(table)}, not a ${kind}; refresh the tree`,
        this.type,
      );
    }
    return objectDetailFromTable(path, table);
  }

  /**
   * Columns for EVERY object of one kind in one database (#789), from the ONE
   * listing the tree already read: the catalog's listing carries every column, so a
   * whole folder is described with no round trip beyond the listing itself.
   *
   * The bound is the CALLER's. `limit + 1` objects are taken so the read itself says
   * whether it stopped short, and `truncated` carries the caller's own limit; a
   * listing the transport's ceiling cut is a second bound, named in its own words
   * and joined to the first.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`${ATHENA_DISPLAY_NAME} declares no object kind "${kind}"`, this.type);
    }
    const database = containerRead(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `An ${ATHENA_DISPLAY_NAME} bulk column read limit must be a positive whole number, received ${limit}`,
        this.type,
      );
    }

    const { tables, truncated } = await this.listing(database);
    const ofKind = tables.filter((table) => kindOf(table) === kind);
    const cut = limit !== undefined && ofKind.length > limit;
    const described = cut ? ofKind.slice(0, limit) : ofKind;
    const details = described
      .map((table: AthenaTable) => objectDetailFromTable(listedObject(capabilities, database, table).path, table))
      .sort((left, right) => comparePaths(left.path, right.path));

    if (cut) return { details, truncated: { limit: limit!, reason: callerBoundTruncationReason(limit!) } };
    if (truncated) {
      return {
        details,
        truncated: {
          limit: details.length,
          reason: `the catalog listing stopped at the first ${OBJECT_LISTING_CEILING} tables of the database`,
        },
      };
    }
    return { details };
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    const runner = this.monitoringRunner();
    return this.guarded(() => readOverview(runner, this.settings.database));
  }

  public getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return readPerformanceMetrics();
  }

  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    const runner = this.monitoringRunner();
    return this.guarded(() => readSlowQueries(runner, options));
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const runner = this.monitoringRunner();
    return this.guarded(() => readActiveSessions(runner, options));
  }

  /** The tables whose catalog entry carries a row count, or an ABSENT panel with the reason. */
  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    const runner = this.monitoringRunner();
    const reading = await this.guarded(() => readTableStats(runner, this.settings.database, options));
    if (reading.refusal !== undefined) throw new QueryError(reading.refusal, this.type);
    return reading.tables;
  }

  /** Empty, and it asks the service nothing: no index object exists in the model. */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.resolve(readIndexStats());
  }

  /** Empty, and it asks the service nothing: the catalog publishes no per-database storage. */
  public getStorageStats(): Promise<StorageStats[]> {
    return Promise.resolve(readStorageStats());
  }

  public async getHealth(): Promise<HealthInfo> {
    const runner = this.monitoringRunner();
    return this.guarded(() => readHealth(runner, this.settings.database));
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * One operation, and it is the only one the service itself performs.
   *
   * `kill` takes the query execution id the sessions panel shows. Every other
   * `MaintenanceType` is refused with the reason rather than mapped onto the
   * nearest-looking statement.
   */
  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    const transport = this.requireTransport();

    if (type !== "kill") {
      throw new QueryError(
        `${ATHENA_DISPLAY_NAME} has no "${type}" operation. It owns no storage to reclaim and computes no statistics of its own - the bytes are in S3 and the counts in the Glue catalog - so the only maintenance it can perform is stopping a running statement.`,
        this.type,
      );
    }
    if (target === undefined || !QUERY_EXECUTION_ID.test(target)) {
      throw new QueryError(
        `Stopping a statement needs its query execution id, which the Sessions panel lists for every statement in flight.`,
        this.type,
      );
    }

    const { executionTime } = await this.measureExecution(() => this.guarded(() => transport.cancel(target)));
    return {
      success: true,
      executionTime,
      // "Asked the service to stop", not "stopped": the call returns once the stop is
      // accepted, and the statement's own record is what reaches CANCELLED.
      message: `Asked ${ATHENA_DISPLAY_NAME} to stop ${target}.`,
    };
  }
}
