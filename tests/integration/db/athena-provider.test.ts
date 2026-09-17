/**
 * Amazon Athena provider, end to end
 *
 * The real provider, the real object surface, the real monitoring reads and the
 * real SDK transport all execute here; only the service is fake. The fake is the
 * scripted client in `tests/helpers/athena-fake.ts`, handed in through the
 * provider's own `deps` - `mock.module()` is refused, being process-wide in bun and
 * able to poison sibling files.
 *
 * NO PAYLOAD BELOW WAS CAPTURED FROM A LIVE SERVICE. The provider has no container
 * fixture (Athena is a managed service with no image), and this suite says so
 * rather than dressing hand-built payloads as measurements: each shape follows the
 * SDK's own model types, which the fake is typed against, and
 * `docs/providers/athena.md` records what still awaits a live pass.
 *
 * What is pinned, in order: metadata · validation · lifecycle · query ·
 * cancellation · error mapping · query preparation · the object surface ·
 * monitoring · maintenance.
 */
import { describe, expect, test } from "bun:test";
import { StartQueryExecutionCommand, StopQueryExecutionCommand, type TableMetadata } from "@aws-sdk/client-athena";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { AthenaProvider, type AthenaProviderDeps } from "@/lib/db/providers/sql/athena/index";
import { ATHENA_MAX_STATS_TABLES } from "@/lib/db/providers/sql/athena/introspect";
import type { AthenaClientLike } from "@/lib/db/providers/sql/athena/sdk-transport";
import type { DatabaseConnection, ProviderOptions } from "@/lib/db/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import {
  column,
  execution,
  FakeClient,
  ID,
  inFlight,
  METADATA,
  page,
  row,
  type Script,
  selectPage,
  serviceError,
  succeeded,
} from "../../helpers/athena-fake";

const DATABASE = "analytics";
const QUERY_TIMEOUT_MS = 500;

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "athena-1",
    name: "Lake",
    type: "athena",
    region: "us-east-1",
    database: DATABASE,
    outputLocation: "s3://lake-results/athena/",
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    ...overrides,
  };
}

/** The workgroup a healthy connection describes. */
const WORKGROUP_ANSWER = {
  WorkGroup: {
    Name: "primary",
    State: "ENABLED" as const,
    Configuration: {
      EngineVersion: { EffectiveEngineVersion: "Athena engine version 3" },
      ResultConfiguration: { OutputLocation: "s3://wg-results/" },
    },
  },
  $metadata: METADATA,
};

function tableMetadata(name: string, overrides: Partial<TableMetadata> = {}): TableMetadata {
  return {
    Name: name,
    TableType: "EXTERNAL_TABLE",
    Columns: [
      { Name: "id", Type: "bigint" },
      { Name: "total", Type: "decimal(12,2)" },
    ],
    PartitionKeys: [{ Name: "dt", Type: "string" }],
    Parameters: {},
    ...overrides,
  };
}

/** The catalog the fixture holds: two tables, one view, in one database. */
const FIXTURE_TABLES: TableMetadata[] = [
  tableMetadata("orders", { Parameters: { numRows: "1200", totalSize: "4096" } }),
  tableMetadata("customers", { PartitionKeys: [] }),
  tableMetadata("v_recent_orders", { TableType: "VIRTUAL_VIEW", PartitionKeys: [] }),
];

const DATABASES_ANSWER = { DatabaseList: [{ Name: DATABASE }, { Name: "staging" }], $metadata: METADATA };

/** A script answering the whole fixture unless a test overrides a piece of it. */
function fixture(overrides: Script = {}): Script {
  return {
    workgroup: WORKGROUP_ANSWER,
    databases: () => DATABASES_ANSWER,
    tables: () => ({ TableMetadataList: FIXTURE_TABLES, $metadata: METADATA }),
    table: { TableMetadata: FIXTURE_TABLES[0], $metadata: METADATA },
    ...overrides,
  };
}

function makeProvider(
  script: Script = fixture(),
  connection: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
): { provider: AthenaProvider; client: FakeClient } {
  const client = new FakeClient(script);
  const deps: AthenaProviderDeps = { client: client as unknown as AthenaClientLike, delay: () => Promise.resolve() };
  const provider = new AthenaProvider(makeConnection(connection), { queryTimeout: QUERY_TIMEOUT_MS, ...options }, deps);
  return { provider, client };
}

async function connected(
  script: Script = fixture(),
  connection: Partial<DatabaseConnection> = {},
): Promise<{ provider: AthenaProvider; client: FakeClient }> {
  const made = makeProvider(script, connection);
  await made.provider.connect();
  return made;
}

// ============================================================================
// Metadata
// ============================================================================

describe("AthenaProvider metadata", () => {
  test("declares SQL with no port, double-quoted identifiers and no statement terminator", () => {
    const capabilities = makeProvider().provider.getCapabilities();

    expect(capabilities.queryLanguage).toBe("sql");
    expect(capabilities.defaultPort).toBeNull();
    expect(capabilities.identifierQuoting).toBe("double");
    expect(capabilities.statementTerminator).toBe("none");
    expect(capabilities.supportsConnectionString).toBe(false);
  });

  // Glue records columns and partition keys and nothing else: no key of any sort, so
  // no column identifies one row and no foreign key exists in the model.
  test("declares no foreign keys, no inline row edit and no transactions", () => {
    const capabilities = makeProvider().provider.getCapabilities();

    expect(capabilities.declaresForeignKeys).toBe(false);
    expect(capabilities.supportsInlineRowEdit).toBe(false);
    expect(capabilities.supportsTransactions).toBe(false);
    expect(capabilities.tablesAreDerivedGroupings).toBeUndefined();
  });

  // A Hive table needs LOCATION and an Iceberg table needs TBLPROPERTIES; the shared
  // modal builds a bare column list, so the button would only produce a refusal.
  test("offers no Create Table and no Explain, each for a stated reason", () => {
    const capabilities = makeProvider().provider.getCapabilities();

    expect(capabilities.supportsCreateTable).toBe(false);
    expect(capabilities.supportsExplain).toBe(false);
    expect(capabilities.explainFormat).toBeUndefined();
  });

  test("declares its one maintenance operation as neither per-table nor global", () => {
    const capabilities = makeProvider().provider.getCapabilities();

    expect(capabilities.supportsMaintenance).toBe(true);
    expect(capabilities.maintenanceOperations).toEqual(["kill"]);
    expect(capabilities.maintenanceOperationSpecs).toEqual({
      kill: { label: "Stop Query", perEntity: false, global: false },
    });
  });

  test("refreshes the tree on DDL and on a partition repair, not on an insert", () => {
    const pattern = new RegExp(makeProvider().provider.getCapabilities().schemaRefreshPattern, "i");

    expect(pattern.test("CREATE TABLE t (id int) LOCATION 's3://b/t/'")).toBe(true);
    expect(pattern.test("MSCK REPAIR TABLE t")).toBe(true);
    expect(pattern.test("INSERT INTO t VALUES (1)")).toBe(false);
  });

  test("declares tables and views at one container level, the database", () => {
    const capabilities = makeProvider().provider.getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id)).toEqual(["table", "view"]);
    expect(kinds.find((kind) => kind.id === "table")?.acceptsRowWrites).toBe(true);
    expect(kinds.find((kind) => kind.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(capabilities.containerLevels).toEqual([{ id: "schema", label: "Database", labelPlural: "Databases" }]);
  });

  test("keeps the inherited table and row nouns, and rewrites only the maintenance copy", () => {
    const labels = makeProvider().provider.getLabels();

    expect(labels.entityName).toBe("Table");
    expect(labels.rowNamePlural).toBe("rows");
    expect(labels.analyzeGlobalDesc).toContain("Glue");
    expect(labels.vacuumGlobalDesc).toContain("S3");
    expect(labels.slowQueriesEmptyState).toContain("execution history");
    expect(labels.slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

// ============================================================================
// Validation
// ============================================================================

describe("AthenaProvider validation", () => {
  test("refuses a connection without a region, as a configuration error naming the field", () => {
    expect(() => makeProvider(fixture(), { region: undefined })).toThrow(DatabaseConfigError);
    expect(() => makeProvider(fixture(), { region: "nowhere" })).toThrow(/not an AWS region code/);
  });

  test("refuses a temporary key and half a key pair before any request is made", () => {
    expect(() => makeProvider(fixture(), { user: "ASIAEXAMPLEEXAMPLE01", password: "s" })).toThrow(/temporary/);
    expect(() => makeProvider(fixture(), { user: "AKIAEXAMPLEEXAMPLE01" })).toThrow(/both halves/);
  });

  test("does not require a database, because a qualified statement needs none", () => {
    expect(() => makeProvider(fixture(), { database: undefined })).not.toThrow();
  });

  // The shared base refuses a record with no id; that refusal is not a settings one
  // and must reach the caller as itself.
  test("lets the base class's own refusal through untouched", () => {
    expect(() => makeProvider(fixture(), { id: "" })).toThrow("Connection ID is required");
  });
});

// ============================================================================
// Lifecycle
// ============================================================================

describe("AthenaProvider lifecycle", () => {
  test("proves the credentials and the workgroup with a description, running no job", async () => {
    const { provider, client } = await connected();

    expect(provider.isConnected()).toBe(true);
    expect(client.of(StartQueryExecutionCommand)).toEqual([]);
  });

  test("falls back to one statement when the policy withholds the workgroup description", async () => {
    const { provider, client } = await connected(fixture({ workgroup: serviceError("AccessDeniedException") }));

    expect(provider.isConnected()).toBe(true);
    expect(client.of(StartQueryExecutionCommand)[0].input.QueryString).toBe("SELECT 1");
  });

  test("reports a refused credential as an authentication failure, not a connectivity one", async () => {
    const { provider } = makeProvider(fixture({ workgroup: serviceError("UnrecognizedClientException", "bad key") }));

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(provider.isConnected()).toBe(false);
  });

  test("reports an unreachable endpoint as a connection failure that names the service", async () => {
    const { provider } = makeProvider(fixture({ workgroup: new Error("getaddrinfo ENOTFOUND") }));

    await expect(provider.connect()).rejects.toThrow(/Failed to connect to Athena/);
    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
  });

  test("refuses a disabled workgroup on connect, with what to do about it", async () => {
    const { provider } = makeProvider(
      fixture({ workgroup: { WorkGroup: { Name: "primary", State: "DISABLED" }, $metadata: METADATA } }),
    );

    await expect(provider.connect()).rejects.toThrow(/is disabled/);
    await expect(provider.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  // The service would fail every statement with "No output location provided"; the
  // form is where the user is standing, so it is refused there.
  test("refuses a connection with nowhere to write results, unless the workgroup names a location", async () => {
    const bare = { WorkGroup: { Name: "primary", State: "ENABLED" as const }, $metadata: METADATA };

    await expect(
      makeProvider(fixture({ workgroup: bare }), { outputLocation: undefined }).provider.connect(),
    ).rejects.toThrow(/nowhere to write a result/);
    await expect(makeProvider(fixture(), { outputLocation: undefined }).provider.connect()).resolves.toBeUndefined();
    await expect(makeProvider(fixture({ workgroup: bare })).provider.connect()).resolves.toBeUndefined();
  });

  // "Managed query results": the service keeps the result in storage it owns, the
  // workgroup carries no location, and a location the connection names must not be
  // sent - so the connection runs as if it had named none.
  test("accepts a workgroup that stores its results itself, and stops sending the connection's location to it", async () => {
    const managed = {
      WorkGroup: {
        Name: "primary",
        State: "ENABLED" as const,
        Configuration: { ManagedQueryResultsConfiguration: { Enabled: true } },
      },
      $metadata: METADATA,
    };

    const bare = await connected(fixture({ workgroup: managed }), { outputLocation: undefined });
    await bare.provider.query("SELECT 1");
    expect("ResultConfiguration" in bare.client.of(StartQueryExecutionCommand)[0].input).toBe(false);

    const located = await connected(fixture({ workgroup: managed }));
    await located.provider.query("SELECT 1");
    expect("ResultConfiguration" in located.client.of(StartQueryExecutionCommand)[0].input).toBe(false);
    expect(located.provider.isConnected()).toBe(true);
  });

  test("keeps sending the connection's location to a workgroup that does not store results itself", async () => {
    const { provider, client } = await connected();

    await provider.query("SELECT 1");

    expect(client.of(StartQueryExecutionCommand)[0].input.ResultConfiguration).toEqual({
      OutputLocation: "s3://lake-results/athena/",
    });
  });

  test("accepts a workgroup whose state the service did not report", async () => {
    const stateless = { WorkGroup: { Name: "primary" }, $metadata: METADATA };

    await expect(makeProvider(fixture({ workgroup: stateless })).provider.connect()).resolves.toBeUndefined();
  });

  test("disconnect releases the client and forgets what was running and what was listed", async () => {
    const { provider, client } = await connected();
    await provider.countObjects([DATABASE]);

    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
    expect(client.destroyed).toBe(true);
    await expect(provider.query("SELECT 1")).rejects.toThrow("not connected");
  });

  test("disconnect is idempotent", async () => {
    const { provider } = makeProvider();

    await expect(provider.disconnect()).resolves.toBeUndefined();
  });
});

// ============================================================================
// Query
// ============================================================================

describe("AthenaProvider query", () => {
  test("returns the rows, the declared fields, the types and the engine's own time", async () => {
    const columns = [column("id", "bigint"), column("name", "varchar")];
    const { provider } = await connected(
      fixture({ results: () => selectPage(columns, [row("1", "Ada"), row("2", "Bob")]) }),
    );

    const result = await provider.query("SELECT id, name FROM orders");

    expect(result).toEqual({
      rows: [
        { id: 1, name: "Ada" },
        { id: 2, name: "Bob" },
      ],
      fields: ["id", "name"],
      rowCount: 2,
      executionTime: 1500,
      columnTypes: { id: "bigint", name: "varchar" },
    });
  });

  test("submits in the connection's database and workgroup, bounded by the query timeout", async () => {
    const { provider, client } = await connected();

    await provider.query("SELECT 1");

    const [start] = client.of(StartQueryExecutionCommand);
    expect(start.input.QueryExecutionContext).toEqual({ Catalog: "AwsDataCatalog", Database: DATABASE });
    expect(start.input.WorkGroup).toBe("primary");
    expect(client.sent.find((call) => call.command === start)?.options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test("counts the rows a statement changed when it returned none, and measures its own time when the service did not", async () => {
    const { provider } = await connected(
      fixture({
        poll: () => succeeded({ StatementType: "DML", Statistics: undefined }),
        results: () => page([], [], { UpdateCount: 3 }),
      }),
    );

    const result = await provider.query("INSERT INTO orders VALUES (1), (2), (3)");

    expect(result.rowCount).toBe(3);
    expect(result.fields).toEqual([]);
    expect("columnTypes" in result).toBe(false);
    expect(typeof result.executionTime).toBe("number");
  });

  test("reports zero rows for a statement that returned none and changed nothing", async () => {
    const { provider } = await connected(
      fixture({ poll: () => succeeded({ StatementType: "DDL" }), results: () => ({ $metadata: METADATA }) }),
    );

    expect((await provider.query("MSCK REPAIR TABLE orders")).rowCount).toBe(0);
  });

  test("refuses positional parameters rather than sending a statement with them unbound", async () => {
    const { provider, client } = await connected();

    await expect(provider.query("SELECT ?", [1])).rejects.toThrow(QueryError);
    expect(client.of(StartQueryExecutionCommand)).toEqual([]);
  });

  test("accepts an empty parameter list, which is what a statement with no values sends", async () => {
    const { provider } = await connected();

    await expect(provider.query("SELECT 1", [])).resolves.toBeDefined();
  });

  test("forgets a database's listing once a DDL statement ran, and keeps it after a query", async () => {
    const { provider, client } = await connected(
      fixture({ poll: (seen) => succeeded({ StatementType: seen === 2 ? "DDL" : "DML" }) }),
    );

    await provider.countObjects([DATABASE]);
    await provider.query("SELECT 1");
    await provider.listObjects([DATABASE], "table");
    const before = client.of(StartQueryExecutionCommand).length;
    await provider.query("DROP TABLE customers");
    await provider.listObjects([DATABASE], "table");

    expect(before).toBe(1);
    expect(client.sent.filter((call) => call.command.constructor.name === "ListTableMetadataCommand")).toHaveLength(2);
  });
});

// ============================================================================
// Cancellation
// ============================================================================

describe("AthenaProvider cancellation", () => {
  test("stops the statement it started, named by the client's own token", async () => {
    const { provider, client } = await connected(
      fixture({
        poll: (seen) => {
          if (seen === 1) void provider.cancelQuery("token-1").then((accepted) => expect(accepted).toBe(true));
          return seen === 1 ? inFlight("RUNNING") : succeeded({ Status: { State: "CANCELLED" } });
        },
      }),
    );

    await expect(provider.query("SELECT 1", undefined, "token-1")).rejects.toBeInstanceOf(QueryCancelledError);
    expect(client.of(StopQueryExecutionCommand)[0].input).toEqual({ QueryExecutionId: ID });
  });

  test("answers false for a token it never recorded, and once the statement has answered", async () => {
    const { provider } = await connected();

    expect(await provider.cancelQuery("unknown")).toBe(false);
    await provider.query("SELECT 1", undefined, "token-2");
    expect(await provider.cancelQuery("token-2")).toBe(false);
  });

  test("records nothing when the caller brought no token", async () => {
    const { provider, client } = await connected();

    await provider.query("SELECT 1");

    expect(client.of(StopQueryExecutionCommand)).toEqual([]);
  });

  test("swallows a refused stop to false rather than throwing over a running statement", async () => {
    const { provider } = await connected(
      fixture({
        stop: serviceError("AccessDeniedException"),
        poll: (seen) => {
          if (seen === 1) void provider.cancelQuery("token-3").then((accepted) => expect(accepted).toBe(false));
          return seen === 1 ? inFlight("RUNNING") : succeeded();
        },
      }),
    );

    await expect(provider.query("SELECT 1", undefined, "token-3")).resolves.toBeDefined();
  });

  test("answers false once disconnected, whatever was recorded", async () => {
    const { provider } = await connected();
    await provider.disconnect();

    expect(await provider.cancelQuery("anything")).toBe(false);
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe("AthenaProvider error mapping", () => {
  const failing = (reason: string): Script =>
    fixture({ poll: () => succeeded({ Status: { State: "FAILED", StateChangeReason: reason } }) });

  test("surfaces the engine's own wording for a refused statement as a query error", async () => {
    const { provider } = await connected(failing("SYNTAX_ERROR: line 1:1: mismatched input 'SELEKT'"));

    const error = await provider.query("SELEKT 1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe("SYNTAX_ERROR: line 1:1: mismatched input 'SELEKT'");
  });

  test("reports a permission the statement lacked as an authentication failure", async () => {
    const { provider } = await connected(failing("PERMISSION_DENIED: Access Denied"));

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("reports the engine's own time limit as a timeout carrying the connection's", async () => {
    const { provider } = await connected(failing("EXCEEDED_TIME_LIMIT: Query exceeded the time limit"));

    const error = await provider.query("SELECT 1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).timeout).toBe(QUERY_TIMEOUT_MS);
  });

  test("reports a service that vanished mid-statement as a connection failure", async () => {
    const { provider } = await connected(fixture({ poll: () => new Error("socket hang up") }));

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("hands anything that is not a transport failure to the shared mapping", async () => {
    const { provider } = await connected();
    const broken = provider as unknown as { transport: { query: () => Promise<never> } };
    broken.transport.query = () => Promise.reject(new TypeError("a bug in the provider"));

    await expect(provider.query("SELECT 1")).rejects.toThrow("a bug in the provider");
  });
});

// ============================================================================
// Query preparation
// ============================================================================

describe("AthenaProvider query preparation", () => {
  test("appends a bound to an unbounded SELECT", () => {
    const prepared = makeProvider().provider.prepareQuery("SELECT * FROM orders", { limit: 50 });

    expect(prepared.query).toBe("SELECT * FROM orders LIMIT 50");
    expect(prepared.wasLimited).toBe(true);
  });

  test("puts OFFSET before LIMIT, which is the only order the engine's grammar has", () => {
    const prepared = makeProvider().provider.prepareQuery("SELECT * FROM orders", { limit: 50, offset: 100 });

    expect(prepared.query).toBe("SELECT * FROM orders OFFSET 100 LIMIT 50");
  });

  test("leaves a statement that already carries its own bound alone", () => {
    const prepared = makeProvider().provider.prepareQuery("SELECT * FROM orders LIMIT 5", { limit: 50, offset: 10 });

    expect(prepared.query).toBe("SELECT * FROM orders LIMIT 5");
    expect(prepared.wasLimited).toBe(false);
  });
});

// ============================================================================
// The object surface (#789)
// ============================================================================

describe("AthenaProvider object surface", () => {
  test("satisfies the shared object surface contract", async () => {
    const { provider } = await connected();

    await assertObjectSurface(provider, {
      containers: [[DATABASE], ["staging"]],
      kinds: { table: 2, view: 1 },
      sampleObject: { path: [DATABASE, "orders"], kind: "table" },
    });
  });

  test("the top level is every database of the catalog, with the connection's own marked", async () => {
    const { provider } = await connected();

    expect(await provider.listContainers()).toEqual([
      { path: [DATABASE], name: DATABASE, level: 0, isSessionDefault: true },
      { path: ["staging"], name: "staging", level: 0, isSessionDefault: false },
    ]);
  });

  test("nothing nests under a database, which is a fact about the engine rather than a refusal", async () => {
    const { provider } = await connected();

    expect(await provider.listContainers([DATABASE])).toEqual([]);
  });

  test("marks no database when the connection pins none", async () => {
    const { provider } = await connected(fixture(), { database: undefined });

    expect((await provider.listContainers()).every((container) => container.isSessionDefault === false)).toBe(true);
  });

  test("counts each kind from one listing, and serves the listing from the cache on the next question", async () => {
    const { provider, client } = await connected();

    expect(await provider.countObjects([DATABASE])).toEqual({ table: { count: 2 }, view: { count: 1 } });
    await provider.listObjects([DATABASE], "view");
    await provider.describeObjects([DATABASE], "table");

    expect(client.sent.filter((call) => call.command.constructor.name === "ListTableMetadataCommand")).toHaveLength(1);
  });

  test("lists the objects of one kind, in code-point order of path", async () => {
    const { provider } = await connected();

    expect(await provider.listObjects([DATABASE], "table")).toEqual([
      { path: [DATABASE, "customers"], name: "customers", kind: "table" },
      { path: [DATABASE, "orders"], name: "orders", kind: "table" },
    ]);
    expect(await provider.listObjects([DATABASE], "view")).toEqual([
      { path: [DATABASE, "v_recent_orders"], name: "v_recent_orders", kind: "view" },
    ]);
  });

  test("refuses a kind the engine does not declare, in every read", async () => {
    const { provider } = await connected();

    await expect(provider.listObjects([DATABASE], "sequence")).rejects.toThrow(/declares no object kind "sequence"/);
    await expect(provider.describeObject([DATABASE, "x"], "sequence")).rejects.toThrow(QueryError);
    await expect(provider.describeObjects([DATABASE], "sequence")).rejects.toThrow(QueryError);
  });

  test("describes one object from its own catalog entry, partition keys after the columns", async () => {
    const { provider } = await connected();

    expect(await provider.describeObject([DATABASE, "orders"], "table")).toEqual({
      path: [DATABASE, "orders"],
      columns: [
        { name: "id", type: "bigint", nullable: true, isPrimary: false },
        { name: "total", type: "decimal(12,2)", nullable: true, isPrimary: false },
        { name: "dt", type: "string", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    });
  });

  test("refuses to describe an object the catalog does not hold", async () => {
    const { provider } = await connected(fixture({ table: serviceError("ResourceNotFoundException") }));

    await expect(provider.describeObject([DATABASE, "nope"], "table")).rejects.toThrow(/No table "nope"/);
  });

  // A stale tree asking for a table under the view folder: answering the columns would
  // let the tree draw one object under two folders.
  test("refuses an object asked for under the wrong kind", async () => {
    const { provider } = await connected();

    await expect(provider.describeObject([DATABASE, "orders"], "view")).rejects.toThrow(/is a table, not a view/);
  });

  test("describes every object of one kind from the listing, with no round trip per object", async () => {
    const { provider, client } = await connected();

    const batch = await provider.describeObjects([DATABASE], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual([
      [DATABASE, "customers"],
      [DATABASE, "orders"],
    ]);
    expect(batch.truncated).toBeUndefined();
    expect(client.sent.filter((call) => call.command.constructor.name === "GetTableMetadataCommand")).toEqual([]);
  });

  test("honours the caller's bound and reports it in the shared sentence", async () => {
    const { provider } = await connected();

    const batch = await provider.describeObjects([DATABASE], "table", 1);

    expect(batch.details).toHaveLength(1);
    expect(batch.truncated).toEqual({ limit: 1, reason: callerBoundTruncationReason(1) });
    expect((await provider.describeObjects([DATABASE], "table", 2)).truncated).toBeUndefined();
  });

  test("refuses a bound that is not a positive whole number", async () => {
    const { provider } = await connected();

    await expect(provider.describeObjects([DATABASE], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(provider.describeObjects([DATABASE], "table", 1.5)).rejects.toThrow(QueryError);
  });

  describe("a database over the listing ceiling", () => {
    // Fifty tables per page and a token on every page: the transport reads one past
    // the ceiling and stops, and everything downstream carries the floor.
    const endless: Script = fixture({
      tables: (_command, seen) => ({
        TableMetadataList: Array.from({ length: 50 }, (_, at) => tableMetadata(`t${seen}_${at}`)),
        NextToken: "more",
        $metadata: METADATA,
      }),
    });

    test("counts a floor rather than a total, and says what bounded it", async () => {
      const { provider } = await connected(endless);

      const counts = await provider.countObjects([DATABASE]);

      expect(counts.table).toEqual({ count: 10_000, sampledFrom: "the first 10000 tables the catalog listed" });
    });

    test("describes what was listed and names the catalog's bound when the caller set none", async () => {
      const { provider } = await connected(endless);

      const batch = await provider.describeObjects([DATABASE], "table");

      expect(batch.details).toHaveLength(10_000);
      expect(batch.truncated).toEqual({
        limit: 10_000,
        reason: "the catalog listing stopped at the first 10000 tables of the database",
      });
    });
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("AthenaProvider monitoring", () => {
  const HISTORY: Script = fixture({
    executions: () => ({ QueryExecutionIds: ["run-1", "run-2"], $metadata: METADATA }),
    batch: () => ({
      QueryExecutions: [
        execution({
          QueryExecutionId: "run-1",
          Query: "SELECT slow",
          Status: { State: "SUCCEEDED", SubmissionDateTime: new Date("2026-09-17T11:00:00.000Z") },
          Statistics: { EngineExecutionTimeInMillis: 9000, DataScannedInBytes: 1 },
        }),
        execution({
          QueryExecutionId: "run-2",
          Query: "SELECT running",
          Status: { State: "RUNNING", SubmissionDateTime: new Date("2026-09-17T11:00:00.000Z") },
          QueryExecutionContext: { Database: DATABASE },
        }),
      ],
      $metadata: METADATA,
    }),
  });

  test("reports the engine version, the statements in flight and the pinned database's table count", async () => {
    const { provider } = await connected(HISTORY);

    const overview = await provider.getOverview();

    expect(overview.version).toBe("Athena engine version 3");
    expect(overview.activeConnections).toBe(1);
    expect(overview.tableCount).toBe(3);
    expect(overview.uptime).toBe("N/A");
    expect("databaseSizeBytes" in overview).toBe(false);
  });

  test("invents no performance metric", async () => {
    expect(await (await connected()).provider.getPerformanceMetrics()).toEqual({});
  });

  test("lists the slowest completed statements and the statements in flight", async () => {
    const { provider } = await connected(HISTORY);

    expect(await provider.getSlowQueries()).toEqual([
      { queryId: "run-1", query: "SELECT slow", calls: 1, totalTime: 9000, avgTime: 9000, rows: 0 },
    ]);
    const [session] = await provider.getActiveSessions();
    expect(session).toMatchObject({ pid: "run-2", query: "SELECT running", state: "RUNNING", database: DATABASE });
  });

  test("reads the row counts the catalog carries, and drops the tables that carry none", async () => {
    const { provider } = await connected();

    expect(await provider.getTableStats()).toEqual([
      {
        schemaName: DATABASE,
        tableName: "orders",
        rowCount: 1200,
        tableSize: "4 KB",
        tableSizeBytes: 4096,
        totalSize: "4 KB",
        totalSizeBytes: 4096,
      },
    ]);
  });

  test("refuses the statistics panel with the reason when no table carries a count", async () => {
    const { provider } = await connected(
      fixture({ tables: () => ({ TableMetadataList: [tableMetadata("bare")], $metadata: METADATA }) }),
    );

    await expect(provider.getTableStats()).rejects.toThrow(/None of the 1 tables/);
  });

  test("narrows the statistics pass to one schema when asked", async () => {
    const { provider, client } = await connected();

    await provider.getTableStats({ schema: "staging" });

    const listed = client.sent.filter((call) => call.command.constructor.name === "ListTableMetadataCommand");
    expect((listed[0].command as { input: { DatabaseName: string } }).input.DatabaseName).toBe("staging");
  });

  test(`the statistics pass and the tree share one listing ceiling of ${ATHENA_MAX_STATS_TABLES}`, async () => {
    const { provider } = await connected(
      fixture({
        tables: (_command, seen) => ({
          TableMetadataList: Array.from({ length: 50 }, (_, at) => tableMetadata(`t${seen}_${at}`)),
          NextToken: "more",
          $metadata: METADATA,
        }),
      }),
    );

    await expect(provider.getTableStats()).rejects.toThrow(/more than 10000 tables/);
  });

  test("reports no indexes and no storage rows, asking the service nothing", async () => {
    const { provider, client } = await connected();
    const before = client.sent.length;

    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    expect(client.sent.length).toBe(before);
  });

  test("composes a health summary from the reads that have a source", async () => {
    const { provider } = await connected(HISTORY);

    const health = await provider.getHealth();

    expect(health.activeConnections).toBe(1);
    expect(health.cacheHitRatio).toBe("N/A");
    expect(health.slowQueries).toEqual([{ query: "SELECT slow", calls: 1, avgTime: "9.00s" }]);
    expect(health.activeSessions[0]).toMatchObject({ pid: "run-2", user: "" });
  });

  test("survives a policy that withholds the history, losing only what it owns", async () => {
    const { provider } = await connected(fixture({ executions: () => serviceError("AccessDeniedException") }));

    expect((await provider.getOverview()).activeConnections).toBe(0);
    expect(await provider.getSlowQueries()).toEqual([]);
  });

  test("surfaces a throttled history as a provider error rather than an empty panel", async () => {
    const { provider } = await connected(fixture({ executions: () => serviceError("TooManyRequestsException") }));

    await expect(provider.getSlowQueries()).rejects.toBeInstanceOf(QueryError);
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("AthenaProvider maintenance", () => {
  test("stops the statement whose id it was given, and says it only asked", async () => {
    const { provider, client } = await connected();

    const result = await provider.runMaintenance("kill", ID);

    expect(result.success).toBe(true);
    expect(result.message).toBe(`Asked Athena to stop ${ID}.`);
    expect(client.of(StopQueryExecutionCommand)[0].input).toEqual({ QueryExecutionId: ID });
  });

  test("refuses a kill with no id, or with something that is not one, rather than guessing", async () => {
    const { provider, client } = await connected();

    await expect(provider.runMaintenance("kill")).rejects.toThrow(/needs its query execution id/);
    await expect(provider.runMaintenance("kill", "orders")).rejects.toThrow(QueryError);
    expect(client.of(StopQueryExecutionCommand)).toEqual([]);
  });

  test("surfaces the service's refusal of a stop", async () => {
    const { provider } = await connected(fixture({ stop: serviceError("AccessDeniedException") }));

    await expect(provider.runMaintenance("kill", ID)).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("refuses every other operation with the reason, and sends nothing", async () => {
    const { provider, client } = await connected();
    const before = client.sent.length;

    for (const type of ["vacuum", "analyze", "reindex", "optimize", "check"] as const) {
      await expect(provider.runMaintenance(type)).rejects.toThrow(/owns no storage to reclaim/);
    }
    expect(client.sent.length).toBe(before);
  });
});
