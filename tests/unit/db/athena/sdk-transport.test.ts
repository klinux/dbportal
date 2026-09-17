/**
 * Athena SDK transport
 *
 * The transport is the only file that knows the SDK, so this is the only test that
 * speaks it: a fake client answers each command class from a script, and the real
 * transport runs against it - the submission, the poll loop and its backoff, the
 * header-row rule, the cell decoding, the result paging, the stop on every exit
 * path, the metadata listings and their ceilings, and the classification of every
 * way the service says no.
 *
 * No `mock.module()` anywhere: it is process-wide in bun and would poison sibling
 * files. The client is handed in through the transport's own `deps`, which is what
 * the seam exists for.
 *
 * The service's payload shapes below follow the SDK's own model types, which the
 * fake is typed against; a field the model does not have does not compile here.
 */
import { describe, expect, test } from "bun:test";
import {
  type AthenaError,
  BatchGetQueryExecutionCommand,
  GetQueryExecutionCommand,
  type GetQueryExecutionCommandOutput,
  GetQueryResultsCommand,
  GetTableMetadataCommand,
  GetWorkGroupCommand,
  ListDatabasesCommand,
  ListQueryExecutionsCommand,
  ListTableMetadataCommand,
  type QueryExecution,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
  type TableMetadata,
} from "@aws-sdk/client-athena";
import { AthenaSdkTransport, type AthenaClientLike, delay } from "@/lib/db/providers/sql/athena/sdk-transport";
import type { AthenaErrorCategory } from "@/lib/db/providers/sql/athena/transport";
import {
  captureError,
  column,
  execution,
  FakeClient,
  ID,
  inFlight,
  makeTransport,
  METADATA,
  page,
  row,
  type Script,
  selectPage,
  serviceError,
  SETTINGS,
  succeeded,
} from "../../../helpers/athena-fake";

// ============================================================================
// Construction
// ============================================================================

describe("AthenaSdkTransport construction", () => {
  test("builds its own client from the settings when none is handed in, with and without a key pair", async () => {
    const own = new AthenaSdkTransport(SETTINGS);
    const keyed = new AthenaSdkTransport({
      ...SETTINGS,
      credentials: { accessKeyId: "AKIAEXAMPLEEXAMPLE01", secretAccessKey: "secret" },
    });

    // Nothing reaches the network: closing releases the SDK's pool and proves the
    // client was constructed.
    await expect(own.close()).resolves.toBeUndefined();
    await expect(keyed.close()).resolves.toBeUndefined();
  });

  test("closing releases the client it was handed", async () => {
    const { transport, client } = makeTransport();

    await transport.close();

    expect(client.destroyed).toBe(true);
  });
});

// ============================================================================
// The submission
// ============================================================================

describe("AthenaSdkTransport submission", () => {
  test("submits the statement in the connection's catalog, database, workgroup and result location", async () => {
    const { transport, client } = makeTransport();

    await transport.query("SELECT 1");

    const [start] = client.of(StartQueryExecutionCommand);
    expect(start.input).toMatchObject({
      QueryString: "SELECT 1",
      QueryExecutionContext: { Catalog: "AwsDataCatalog", Database: "analytics" },
      WorkGroup: "primary",
      ResultConfiguration: { OutputLocation: "s3://lake-results/athena/" },
    });
    // A UUID: the service requires 32 to 128 characters and the SDK's retry replays it.
    expect(start.input.ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("names no database and no result location when the connection carries none", async () => {
    const { transport, client } = makeTransport({}, { ...SETTINGS, database: undefined, outputLocation: undefined });

    await transport.query("SELECT 1");

    const [start] = client.of(StartQueryExecutionCommand);
    expect(start.input.QueryExecutionContext).toEqual({ Catalog: "AwsDataCatalog" });
    expect("ResultConfiguration" in start.input).toBe(false);
  });

  test("issues a fresh idempotency token per statement", async () => {
    const { transport, client } = makeTransport();

    await transport.query("SELECT 1");
    await transport.query("SELECT 2");

    const tokens = client.of(StartQueryExecutionCommand).map((start) => start.input.ClientRequestToken);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test("drops the lone terminator the engine refuses, and nothing else", async () => {
    const { transport, client } = makeTransport();

    await transport.query("SELECT 1;");
    await transport.query("SELECT 1;\n");
    await transport.query("SELECT 1");
    await transport.query("SELECT ';' AS c");
    await transport.query("SELECT 1; SELECT 2");
    await transport.query("SELECT 'unclosed;");

    expect(client.of(StartQueryExecutionCommand).map((start) => start.input.QueryString)).toEqual([
      "SELECT 1",
      "SELECT 1",
      "SELECT 1",
      "SELECT ';' AS c",
      "SELECT 1; SELECT 2",
      "SELECT 'unclosed;",
    ]);
  });

  test("announces the id as soon as the service accepted the statement", async () => {
    const { transport } = makeTransport();
    const started: string[] = [];

    await transport.query("SELECT 1", { onQueryStarted: (id) => started.push(id) });

    expect(started).toEqual([ID]);
  });

  test("refuses an acceptance that identifies nothing, which is not the service", async () => {
    const { transport, client } = makeTransport({ start: { $metadata: METADATA } });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe("unreachable");
    expect(error.message).toContain("without identifying it");
    // Nothing to stop: no id was ever learned.
    expect(client.of(StopQueryExecutionCommand)).toEqual([]);
  });
});

// ============================================================================
// The poll
// ============================================================================

describe("AthenaSdkTransport poll", () => {
  test("polls until the job leaves its in-flight states", async () => {
    const { transport, client } = makeTransport({
      poll: (seen) => (seen === 1 ? inFlight("QUEUED") : seen === 2 ? inFlight("RUNNING") : succeeded()),
    });

    await transport.query("SELECT 1");

    expect(client.of(GetQueryExecutionCommand)).toHaveLength(3);
    expect(client.of(GetQueryExecutionCommand)[0].input).toEqual({ QueryExecutionId: ID });
  });

  test("backs off from 200 ms by half again per poll and settles at one second", async () => {
    const waits: number[] = [];
    const client = new FakeClient({ poll: (seen) => (seen < 8 ? inFlight("RUNNING") : succeeded()) });
    const transport = new AthenaSdkTransport(SETTINGS, {
      client: client as unknown as AthenaClientLike,
      delay: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    await transport.query("SELECT 1");

    expect(waits).toEqual([200, 300, 450, 675, 1000, 1000, 1000, 1000]);
  });

  test("waits in real time by default, so a poll is not a busy loop", async () => {
    const client = new FakeClient({});
    const transport = new AthenaSdkTransport(SETTINGS, { client: client as unknown as AthenaClientLike });
    const before = performance.now();

    await transport.query("SELECT 1");

    expect(performance.now() - before).toBeGreaterThanOrEqual(150);
  });

  test("stops the job and reports a cancellation when the caller aborts mid-poll", async () => {
    const controller = new AbortController();
    const { transport, client } = makeTransport({
      poll: () => {
        controller.abort();
        return inFlight("RUNNING");
      },
    });

    const error = await captureError(() => transport.query("SELECT 1", { signal: controller.signal }));

    expect(error.category).toBe("cancelled");
    expect(client.of(StopQueryExecutionCommand)[0].input).toEqual({ QueryExecutionId: ID });
  });

  test("reports a deadline as a timeout, and still stops the job", async () => {
    // The real wait, so the deadline is what interrupts the poll rather than the
    // fake: the submission is accepted, the first 200 ms wait is cut short by the
    // 30 ms deadline, and the job is stopped on the way out.
    const client = new FakeClient({ poll: () => inFlight("RUNNING") });
    const transport = new AthenaSdkTransport(SETTINGS, { client: client as unknown as AthenaClientLike });

    const error = await captureError(() => transport.query("SELECT 1", { signal: AbortSignal.timeout(30) }));

    expect(error.category).toBe("timeout");
    expect(client.of(StopQueryExecutionCommand)).toHaveLength(1);
  });

  test("the real wait ends early on abort, rejecting with the caller's reason", async () => {
    const controller = new AbortController();
    const waiting = delay(10_000, controller.signal);
    controller.abort(new Error("the tab closed"));

    await expect(waiting).rejects.toThrow("the tab closed");
  });

  test("the real wait resolves on its own and detaches its abort listener", async () => {
    const controller = new AbortController();

    await expect(delay(1, controller.signal)).resolves.toBeUndefined();
    // A listener left attached would fire on a later abort against a settled promise.
    controller.abort();
  });

  test("abandons a job the service never moves to a terminal state, and stops it", async () => {
    const { transport, client } = makeTransport({ poll: () => inFlight("RUNNING") });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe("timeout");
    expect(error.message).toContain("7200 polls");
    expect(client.of(GetQueryExecutionCommand)).toHaveLength(7200);
    expect(client.of(StopQueryExecutionCommand)).toHaveLength(1);
  });

  test("swallows a failed stop so the statement's own failure is what the caller sees", async () => {
    const { transport } = makeTransport({
      poll: () => inFlight("RUNNING"),
      stop: serviceError("InternalServerException"),
    });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe("timeout");
  });
});

// ============================================================================
// Failed and cancelled jobs
// ============================================================================

describe("AthenaSdkTransport job failures", () => {
  function failed(reason?: string, athenaError?: AthenaError) {
    return (): GetQueryExecutionCommandOutput =>
      succeeded({ Status: { State: "FAILED", StateChangeReason: reason, AthenaError: athenaError } });
  }

  test.each<[string, AthenaErrorCategory]>([
    ["SYNTAX_ERROR: line 1:1: mismatched input 'SELEKT'", "syntax"],
    ["TABLE_NOT_FOUND: line 1:15: Table 'awsdatacatalog.analytics.nope' does not exist", "unknown-object"],
    ["COLUMN_NOT_FOUND: line 1:8: Column 'x' cannot be resolved", "unknown-object"],
    ["SCHEMA_NOT_FOUND: Schema 'nope' does not exist", "unknown-object"],
    ["NOT_SUPPORTED: This connector does not support modifying table rows", "unsupported"],
    ["PERMISSION_DENIED: Access Denied", "auth"],
    ["USER_CANCELED: Query was cancelled", "cancelled"],
    ["EXCEEDED_TIME_LIMIT: Query exceeded the time limit", "timeout"],
    ["EXCEEDED_MEMORY_LIMIT: Query exhausted resources at this scale factor", "resources"],
    ["GENERIC_INTERNAL_ERROR: something the engine did not classify", "engine"],
    ["a reason with no fault name at its head", "engine"],
  ])("classifies %s as %s, keeping the engine's own wording", async (reason, category) => {
    const { transport, client } = makeTransport({ poll: failed(reason) });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe(category);
    expect(error.message).toBe(reason);
    expect(error.code).toBe(reason.match(/^([A-Z_]+):/)?.[1] ?? null);
    // A failed job is finished; stopping it is harmless, and the exit path owes it.
    expect(client.of(StopQueryExecutionCommand)).toHaveLength(1);
  });

  test("reads the message off the structured error when the reason is absent", async () => {
    const { transport } = makeTransport({ poll: failed(undefined, { ErrorCategory: 2, ErrorMessage: "structured" }) });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.message).toBe("structured");
    expect(error.category).toBe("engine");
  });

  test("says the service refused the statement when it said nothing at all", async () => {
    const { transport } = makeTransport({ poll: failed() });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.message).toBe("Athena refused the statement");
  });

  // The numeric category says only whose fault it was; the one thing it decides is
  // that a SYSTEM fault the service itself marks retryable is a resources refusal.
  test("classifies a fault the service marks retryable as a resources refusal", async () => {
    const { transport } = makeTransport({
      poll: failed("something transient", { ErrorCategory: 1, Retryable: true }),
    });

    expect((await captureError(() => transport.query("SELECT 1"))).category).toBe("resources");
  });

  test("reports a job the service cancelled as a cancellation, with the reason when it gave one", async () => {
    const { transport } = makeTransport({
      poll: () => succeeded({ Status: { State: "CANCELLED", StateChangeReason: "stopped from the console" } }),
    });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe("cancelled");
    expect(error.message).toBe("stopped from the console");
    expect(error.code).toBe("CANCELLED");
  });

  test("names the service in a cancellation that carried no reason", async () => {
    const { transport } = makeTransport({ poll: () => succeeded({ Status: { State: "CANCELLED" } }) });

    expect((await captureError(() => transport.query("SELECT 1"))).message).toContain("cancelled on Athena");
  });
});

// ============================================================================
// Reading the result
// ============================================================================

describe("AthenaSdkTransport result", () => {
  test("drops the header row a DML result set starts with, and decodes the cells by type", async () => {
    const columns = [
      column("id", "bigint"),
      column("name", "varchar"),
      column("paid", "boolean"),
      column("score", "double"),
    ];
    const { transport } = makeTransport({
      results: () => selectPage(columns, [row("1", "Ada", "true", "1.5"), row("2", null, "false", "NaN")]),
    });

    const result = await transport.query("SELECT 1");

    expect(result.fieldNames).toEqual(["id", "name", "paid", "score"]);
    expect(result.columnTypes).toEqual({ id: "bigint", name: "varchar", paid: "boolean", score: "double" });
    expect(result.rows).toEqual([
      { id: 1, name: "Ada", paid: true, score: 1.5 },
      { id: 2, name: null, paid: false, score: "NaN" },
    ]);
    expect(result.statementType).toBe("DML");
    expect(result.queryExecutionId).toBe(ID);
  });

  test("keeps a DML first row that is not the header", async () => {
    const columns = [column("a", "varchar")];
    const { transport } = makeTransport({ results: () => page(columns, [row("x")]) });

    expect((await transport.query("SELECT 1")).rows).toEqual([{ a: "x" }]);
  });

  test("keeps a data row that repeats the column names when the statement is not DML", async () => {
    const columns = [column("tab_name", "varchar")];
    const { transport } = makeTransport({
      poll: () => succeeded({ StatementType: "UTILITY" }),
      results: () => page(columns, [row("tab_name"), row("orders")]),
    });

    const result = await transport.query("SHOW TABLES");

    expect(result.rows).toEqual([{ tab_name: "tab_name" }, { tab_name: "orders" }]);
    expect(result.statementType).toBe("UTILITY");
  });

  test("answers a SELECT that matched nothing with no rows, once the header is dropped", async () => {
    const columns = [column("a", "varchar")];
    const { transport } = makeTransport({ results: () => selectPage(columns, []) });

    const result = await transport.query("SELECT 1");

    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toEqual(["a"]);
  });

  test.each<[string, string, unknown]>([
    ["bigint", "9007199254740993", "9007199254740993"],
    ["bigint", "-42", -42],
    ["integer", "1e3", "1e3"],
    ["tinyint", "7", 7],
    ["smallint", "not a number", "not a number"],
    ["real", "Infinity", "Infinity"],
    ["float", "2.5", 2.5],
    ["boolean", "maybe", "maybe"],
    ["decimal", "1.10", "1.10"],
    ["timestamp", "2026-09-17 12:00:00.000", "2026-09-17 12:00:00.000"],
    ["varbinary", "00 ff", "00 ff"],
  ])("passes a %s cell of %s through as %p", async (type, text, expected) => {
    const columns = [column("c", type)];
    const { transport } = makeTransport({ results: () => page(columns, [row(text)]) });

    expect((await transport.query("SELECT 1")).rows).toEqual([{ c: expected }]);
  });

  test("disambiguates a duplicated output column instead of dropping it", async () => {
    const columns = [
      column("c", "integer"),
      column("c", "integer"),
      column("c (2)", "integer"),
      column("c", "integer"),
    ];
    const { transport } = makeTransport({ results: () => page(columns, [row("1", "2", "3", "4")]) });

    const result = await transport.query("SELECT 1");

    expect(result.fieldNames).toEqual(["c", "c (2)", "c (2) (2)", "c (3)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2, "c (2) (2)": 3, "c (3)": 4 }]);
  });

  test("names an unnamed, untyped column with empty text rather than inventing one", async () => {
    const { transport } = makeTransport({ results: () => page([{ Name: undefined, Type: undefined }], [row("v")]) });

    const result = await transport.query("SELECT 1");

    expect(result.fieldNames).toEqual([""]);
    expect(result.columnTypes).toEqual({ "": "" });
  });

  test("pads a row the service sent short, and reads a missing Data as all null", async () => {
    const columns = [column("a", "varchar"), column("b", "varchar")];
    const { transport } = makeTransport({ results: () => page(columns, [{ Data: [{ VarCharValue: "x" }] }, {}]) });

    expect((await transport.query("SELECT 1")).rows).toEqual([
      { a: "x", b: null },
      { a: null, b: null },
    ]);
  });

  test("follows the result pages, carrying the declaration from the first", async () => {
    const columns = [column("n", "integer")];
    const { transport, client } = makeTransport({
      results: (command, seen) =>
        seen === 1
          ? selectPage(columns, [row("1")], { NextToken: "p2" })
          : seen === 2
            ? { ResultSet: { Rows: [row("2")] }, NextToken: "p3", $metadata: METADATA }
            : { ResultSet: { Rows: [row("3")] }, NextToken: "", $metadata: METADATA },
    });

    const result = await transport.query("SELECT 1");

    expect(result.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const pages = client.of(GetQueryResultsCommand).map((command) => command.input);
    expect(pages[0]).toEqual({ QueryExecutionId: ID, MaxResults: 1000 });
    expect(pages[1]).toEqual({ QueryExecutionId: ID, MaxResults: 1000, NextToken: "p2" });
    expect(pages).toHaveLength(3);
  });

  test("refuses rows that arrived before any declaration, and stops the job", async () => {
    const { transport, client } = makeTransport({
      results: () => ({ ResultSet: { Rows: [row("1")] }, $metadata: METADATA }),
    });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe("engine");
    expect(error.message).toContain("never declared columns");
    expect(client.of(StopQueryExecutionCommand)).toHaveLength(1);
  });

  test("answers null field names when the service described nothing and sent nothing", async () => {
    const { transport } = makeTransport({
      poll: () => succeeded({ StatementType: "DDL" }),
      results: () => ({ $metadata: METADATA }),
    });

    const result = await transport.query("CREATE TABLE t (id int) LOCATION 's3://b/t/'");

    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.statementType).toBe("DDL");
  });

  test("an empty declaration is empty, not absent", async () => {
    const { transport } = makeTransport({ results: () => page([], []) });

    const result = await transport.query("SELECT 1");

    expect(result.fieldNames).toEqual([]);
    expect(result.columnTypes).toEqual({});
  });

  test("reports what a mutation changed", async () => {
    const { transport } = makeTransport({ results: () => page([], [], { UpdateCount: 3 }) });

    expect((await transport.query("INSERT INTO t VALUES (1), (2), (3)")).affectedRows).toBe(3);
  });

  test("leaves the changed-row count null for an ordinary query", async () => {
    const { transport } = makeTransport();

    expect((await transport.query("SELECT 1")).affectedRows).toBeNull();
  });

  test("reports the service's own execution numbers and the result object", async () => {
    const { transport } = makeTransport();

    expect((await transport.query("SELECT 1")).stats).toEqual({
      engineMs: 1500,
      queuedMs: 100,
      totalMs: 1800,
      scannedBytes: 4096,
      resultLocation: `s3://lake-results/athena/${ID}.csv`,
    });
  });

  test("admits it when the service reported no numbers, no location and no statement type", async () => {
    const { transport } = makeTransport({
      poll: () =>
        succeeded({
          Statistics: undefined,
          ResultConfiguration: undefined,
          StatementType: undefined,
        }),
    });

    const result = await transport.query("SELECT 1");

    expect(result.stats).toEqual({
      engineMs: null,
      queuedMs: null,
      totalMs: null,
      scannedBytes: null,
      resultLocation: null,
    });
    expect(result.statementType).toBeNull();
  });

  test("refuses a number the report rendered unusably", async () => {
    const { transport } = makeTransport({
      poll: () => succeeded({ Statistics: { EngineExecutionTimeInMillis: Number.NaN } }),
    });

    expect((await transport.query("SELECT 1")).stats.engineMs).toBeNull();
  });

  test("refuses an answer past the row ceiling rather than cutting it, and stops the job", async () => {
    const columns = [column("n", "integer")];
    const { transport, client } = makeTransport({
      results: () =>
        page(
          columns,
          Array.from({ length: 1000 }, () => row("1")),
          { NextToken: "more" },
        ),
    });

    const error = await captureError(() => transport.query("SHOW PARTITIONS huge"));

    expect(error.category).toBe("resources");
    expect(error.message).toContain("more than 200000 rows");
    expect(client.of(StopQueryExecutionCommand)).toHaveLength(1);
  });

  test("passes the caller's signal to every request of the statement", async () => {
    const controller = new AbortController();
    const { transport, client } = makeTransport();

    await transport.query("SELECT 1", { signal: controller.signal });

    const signalled = client.sent.filter((call) => call.options?.abortSignal === controller.signal);
    expect(signalled.map((call) => call.command.constructor.name)).toEqual([
      "StartQueryExecutionCommand",
      "GetQueryExecutionCommand",
      "GetQueryResultsCommand",
    ]);
  });
});

// ============================================================================
// Refusals before a statement exists
// ============================================================================

describe("AthenaSdkTransport request failures", () => {
  test.each<[string, AthenaErrorCategory]>([
    ["AccessDeniedException", "auth"],
    ["UnrecognizedClientException", "auth"],
    ["InvalidSignatureException", "auth"],
    ["ExpiredTokenException", "auth"],
    ["CredentialsProviderError", "auth"],
    ["TooManyRequestsException", "resources"],
    ["ThrottlingException", "resources"],
    ["ResourceNotFoundException", "unknown-object"],
    ["InvalidRequestException", "engine"],
    ["MetadataException", "engine"],
    ["InternalServerException", "engine"],
  ])("classifies a %s answered by the service as %s", async (name, category) => {
    const { transport } = makeTransport({ start: serviceError(name, `${name} said so`) });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe(category);
    expect(error.code).toBe(name);
    expect(error.message).toBe(`${name} said so`);
  });

  test("reports a failure that never reached the service as unreachable", async () => {
    const socket = Object.assign(new Error("getaddrinfo ENOTFOUND athena.us-east-1.amazonaws.com"), {
      code: "ENOTFOUND",
    });
    const { transport } = makeTransport({ start: socket });

    const error = await captureError(() => transport.query("SELECT 1"));

    expect(error.category).toBe("unreachable");
    expect(error.message).toContain("could not be reached: getaddrinfo ENOTFOUND");
  });

  test("wraps a thrown non-error rather than losing it", async () => {
    const { transport } = makeTransport({ start: "boom" as unknown as Error });

    // The fake resolves a string rather than rejecting, so the id check fires first;
    // reject explicitly to reach the wrapping.
    const client = new FakeClient({});
    client.send = () => Promise.reject("boom");
    const wrapped = new AthenaSdkTransport(SETTINGS, { client: client as unknown as AthenaClientLike });

    expect((await captureError(() => wrapped.query("SELECT 1"))).message).toContain("boom");
    expect((await captureError(() => transport.query("SELECT 1"))).category).toBe("unreachable");
  });

  test("reports an abort the caller asked for as a cancellation even when the SDK's own error says otherwise", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport } = makeTransport({ start: serviceError("AbortError", "Request aborted") });

    expect((await captureError(() => transport.query("SELECT 1", { signal: controller.signal }))).category).toBe(
      "cancelled",
    );
  });
});

// ============================================================================
// Cancellation on demand
// ============================================================================

describe("AthenaSdkTransport cancel", () => {
  test("stops the job by id, passing the caller's signal", async () => {
    const controller = new AbortController();
    const { transport, client } = makeTransport();

    await transport.cancel(ID, controller.signal);

    const [call] = client.sent;
    expect((call.command as StopQueryExecutionCommand).input).toEqual({ QueryExecutionId: ID });
    expect(call.options?.abortSignal).toBe(controller.signal);
  });

  test("reports a refused stop through the seam's error", async () => {
    const { transport } = makeTransport({ stop: serviceError("AccessDeniedException") });

    expect((await captureError(() => transport.cancel(ID))).category).toBe("auth");
  });
});

// ============================================================================
// The catalog
// ============================================================================

describe("AthenaSdkTransport catalog", () => {
  function tableMetadata(name: string, overrides: Partial<TableMetadata> = {}): TableMetadata {
    return {
      Name: name,
      TableType: "EXTERNAL_TABLE",
      Columns: [{ Name: "id", Type: "bigint" }],
      PartitionKeys: [{ Name: "dt", Type: "string" }],
      Parameters: { numRows: "3" },
      ...overrides,
    };
  }

  test("lists every database of the catalog across the pages the service hands out", async () => {
    const { transport, client } = makeTransport({
      databases: (_command, seen) =>
        seen === 1
          ? { DatabaseList: [{ Name: "analytics" }, { Name: undefined }], NextToken: "n2", $metadata: METADATA }
          : { DatabaseList: [{ Name: "staging" }], $metadata: METADATA },
    });

    expect(await transport.listDatabases()).toEqual([{ name: "analytics" }, { name: "staging" }]);
    const inputs = client.of(ListDatabasesCommand).map((command) => command.input);
    expect(inputs[0]).toEqual({ CatalogName: "AwsDataCatalog", MaxResults: 50 });
    expect(inputs[1]).toEqual({ CatalogName: "AwsDataCatalog", MaxResults: 50, NextToken: "n2" });
  });

  test("answers no database for a catalog that answered no list", async () => {
    const { transport } = makeTransport({ databases: () => ({ $metadata: METADATA }) });

    expect(await transport.listDatabases()).toEqual([]);
  });

  test("abandons a database listing the service never ends", async () => {
    const { transport, client } = makeTransport({
      databases: () => ({ DatabaseList: [{ Name: "d" }], NextToken: "again", $metadata: METADATA }),
    });

    const error = await captureError(() => transport.listDatabases());

    expect(error.message).toContain("past 100 pages");
    expect(client.of(ListDatabasesCommand)).toHaveLength(100);
  });

  test("lists a database's tables with their columns, partition keys and properties", async () => {
    const { transport, client } = makeTransport({
      tables: () => ({
        TableMetadataList: [
          tableMetadata("orders"),
          tableMetadata("v_orders", { TableType: "VIRTUAL_VIEW", PartitionKeys: undefined, Parameters: undefined }),
          tableMetadata("bare", {
            TableType: undefined,
            Columns: [{ Name: undefined }, { Name: "c", Type: undefined }],
          }),
          { Name: undefined },
        ],
        $metadata: METADATA,
      }),
    });

    const listing = await transport.listTables("analytics", 100);

    expect(listing).toEqual({
      tables: [
        {
          name: "orders",
          tableType: "EXTERNAL_TABLE",
          columns: [{ name: "id", type: "bigint" }],
          partitionKeys: [{ name: "dt", type: "string" }],
          parameters: { numRows: "3" },
        },
        {
          name: "v_orders",
          tableType: "VIRTUAL_VIEW",
          columns: [{ name: "id", type: "bigint" }],
          partitionKeys: [],
          parameters: {},
        },
        {
          name: "bare",
          tableType: null,
          columns: [{ name: "c", type: "" }],
          partitionKeys: [{ name: "dt", type: "string" }],
          parameters: { numRows: "3" },
        },
      ],
      truncated: false,
    });
    expect(client.of(ListTableMetadataCommand)[0].input).toEqual({
      CatalogName: "AwsDataCatalog",
      DatabaseName: "analytics",
      MaxResults: 50,
    });
  });

  test("reads one table past the ceiling, so a cut listing is told apart from an exact one", async () => {
    const script = (size: number, pages: number): Script => ({
      tables: (_command, seen) => ({
        TableMetadataList: Array.from({ length: size }, (_, at) => tableMetadata(`t${seen}_${at}`)),
        ...(seen < pages ? { NextToken: `n${seen + 1}` } : {}),
        $metadata: METADATA,
      }),
    });

    const exact = await makeTransport(script(50, 2)).transport.listTables("analytics", 100);
    expect(exact.truncated).toBe(false);
    expect(exact.tables).toHaveLength(100);

    const cut = await makeTransport(script(50, 3)).transport.listTables("analytics", 100);
    expect(cut.truncated).toBe(true);
    expect(cut.tables).toHaveLength(100);
    expect(cut.tables[99].name).toBe("t2_49");

    const { transport, client } = makeTransport(script(50, 3));
    await transport.listTables("analytics", 60);
    // 60 wanted: two pages read (101 > 60 stops the loop), the third never asked for.
    expect(client.of(ListTableMetadataCommand)).toHaveLength(2);
  });

  test("describes one table, and answers null for a name the catalog does not hold", async () => {
    const found = makeTransport({ table: { TableMetadata: tableMetadata("orders"), $metadata: METADATA } });
    const empty = makeTransport({ table: { $metadata: METADATA } });
    const unnamed = makeTransport({ table: { TableMetadata: { Name: undefined }, $metadata: METADATA } });
    const missing = makeTransport({ table: serviceError("ResourceNotFoundException") });

    expect((await found.transport.describeTable("analytics", "orders"))?.name).toBe("orders");
    expect(found.client.of(GetTableMetadataCommand)[0].input).toEqual({
      CatalogName: "AwsDataCatalog",
      DatabaseName: "analytics",
      TableName: "orders",
    });
    expect(await empty.transport.describeTable("analytics", "orders")).toBeNull();
    expect(await unnamed.transport.describeTable("analytics", "orders")).toBeNull();
    expect(await missing.transport.describeTable("analytics", "orders")).toBeNull();
  });

  // "No such table" over a denied read would render a dropped table where there is a
  // permission problem.
  test("propagates a denied table description rather than reading it as absent", async () => {
    const { transport } = makeTransport({ table: serviceError("AccessDeniedException") });

    expect((await captureError(() => transport.describeTable("analytics", "orders"))).category).toBe("auth");
  });
});

// ============================================================================
// The workgroup and the history
// ============================================================================

describe("AthenaSdkTransport workgroup", () => {
  test("describes the workgroup's state, engine, result location, enforcement and scan ceiling", async () => {
    const { transport, client } = makeTransport({
      workgroup: {
        WorkGroup: {
          Name: "reporting",
          State: "ENABLED",
          Configuration: {
            ResultConfiguration: { OutputLocation: "s3://wg-results/" },
            EnforceWorkGroupConfiguration: true,
            BytesScannedCutoffPerQuery: 10_000_000_000,
            EngineVersion: { EffectiveEngineVersion: "Athena engine version 3" },
          },
        },
        $metadata: METADATA,
      },
    });

    expect(await transport.describeWorkgroup()).toEqual({
      name: "reporting",
      state: "ENABLED",
      engineVersion: "Athena engine version 3",
      outputLocation: "s3://wg-results/",
      managedResults: false,
      enforcesConfiguration: true,
      bytesScannedCutoff: 10_000_000_000,
    });
    expect(client.of(GetWorkGroupCommand)[0].input).toEqual({ WorkGroup: "primary" });
  });

  // A workgroup keeping its results in the service's own storage carries no result
  // location, and the seam says which of the two it is rather than leaving a null to
  // be read as "nowhere to write".
  test("reports a workgroup whose results the service stores itself", async () => {
    const { transport } = makeTransport({
      workgroup: {
        WorkGroup: {
          Name: "managed",
          State: "ENABLED",
          Configuration: { ManagedQueryResultsConfiguration: { Enabled: true } },
        },
        $metadata: METADATA,
      },
    });

    const info = await transport.describeWorkgroup();

    expect(info.managedResults).toBe(true);
    expect(info.outputLocation).toBeNull();
  });

  test("falls back to the connection's own workgroup name and nulls when the answer is bare", async () => {
    const { transport } = makeTransport({ workgroup: { $metadata: METADATA } });

    expect(await transport.describeWorkgroup()).toEqual({
      name: "primary",
      state: null,
      engineVersion: null,
      outputLocation: null,
      managedResults: false,
      enforcesConfiguration: false,
      bytesScannedCutoff: null,
    });
  });
});

describe("AthenaSdkTransport executions", () => {
  test("lists the recent ids newest first and describes them in batches, in the listing's order", async () => {
    const ids = Array.from({ length: 60 }, (_, at) => `id-${at}`);
    const { transport, client } = makeTransport({
      executions: (_command, seen) =>
        seen === 1
          ? { QueryExecutionIds: [...ids.slice(0, 50), ""], NextToken: "n2", $metadata: METADATA }
          : { QueryExecutionIds: ids.slice(50), $metadata: METADATA },
      batch: (command) => ({
        // Answered in reverse, to prove the order is the listing's and not the batch's.
        QueryExecutions: [...(command.input.QueryExecutionIds ?? [])].reverse().map((id) =>
          execution({
            QueryExecutionId: id,
            Query: `SELECT '${id}'`,
            WorkGroup: "primary",
            QueryExecutionContext: { Database: "analytics" },
            Status: {
              State: "SUCCEEDED",
              SubmissionDateTime: new Date("2026-09-17T11:00:00.000Z"),
              CompletionDateTime: new Date("2026-09-17T11:00:01.000Z"),
            },
          }),
        ),
        $metadata: METADATA,
      }),
    });

    const summaries = await transport.listExecutions(60);

    expect(summaries.map((summary) => summary.queryExecutionId)).toEqual(ids);
    expect(summaries[0]).toEqual({
      queryExecutionId: "id-0",
      statement: "SELECT 'id-0'",
      state: "SUCCEEDED",
      database: "analytics",
      workgroup: "primary",
      submittedAt: new Date("2026-09-17T11:00:00.000Z"),
      completedAt: new Date("2026-09-17T11:00:01.000Z"),
      engineMs: 1500,
      queuedMs: 100,
      scannedBytes: 4096,
    });
    const listed = client.of(ListQueryExecutionsCommand).map((command) => command.input);
    expect(listed[0]).toEqual({ WorkGroup: "primary", MaxResults: 50 });
    expect(listed[1]).toEqual({ WorkGroup: "primary", MaxResults: 10, NextToken: "n2" });
    expect(client.of(BatchGetQueryExecutionCommand).map((command) => command.input.QueryExecutionIds?.length)).toEqual([
      50, 10,
    ]);
  });

  test("answers nothing without a description call when the workgroup ran nothing", async () => {
    const { transport, client } = makeTransport();

    expect(await transport.listExecutions(20)).toEqual([]);
    expect(client.of(BatchGetQueryExecutionCommand)).toEqual([]);
  });

  test("skips an id the batch did not describe, and reads a bare description as blanks", async () => {
    const { transport } = makeTransport({
      executions: () => ({ QueryExecutionIds: ["described", "vanished"], $metadata: METADATA }),
      batch: () => ({
        QueryExecutions: [{ QueryExecutionId: "described" }, { QueryExecutionId: undefined }],
        $metadata: METADATA,
      }),
    });

    expect(await transport.listExecutions(20)).toEqual([
      {
        queryExecutionId: "described",
        statement: "",
        state: "",
        database: null,
        workgroup: null,
        submittedAt: null,
        completedAt: null,
        engineMs: null,
        queuedMs: null,
        scannedBytes: null,
      },
    ]);
  });

  test("stops listing when the service hands out no more pages", async () => {
    const { transport, client } = makeTransport({
      executions: () => ({ QueryExecutionIds: ["one"], $metadata: METADATA }),
      batch: () => ({ QueryExecutions: [execution({ QueryExecutionId: "one" })], $metadata: METADATA }),
    });

    expect(await transport.listExecutions(200)).toHaveLength(1);
    expect(client.of(ListQueryExecutionsCommand)).toHaveLength(1);
  });
});
