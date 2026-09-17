/**
 * Athena monitoring reads
 *
 * Every read takes a runner rather than a transport, and each test hands it a
 * hand-built one: a workgroup description, a recent execution history and a table
 * listing shaped the way the seam carries them. What is pinned is the reading each
 * panel makes of that record and, above all, what each panel says when the record
 * is not there - a withheld permission, a database over the listing ceiling, a
 * catalog nobody crawled.
 */
import { describe, expect, test } from "bun:test";
import {
  ATHENA_DEFAULT_SESSION_LIMIT,
  ATHENA_DEFAULT_SLOW_QUERY_LIMIT,
  ATHENA_HISTORY_WINDOW,
  ATHENA_MAX_STATS_TABLES,
  ATHENA_UNAVAILABLE_TEXT,
  ATHENA_UNKNOWN_TEXT,
  type AthenaMonitoringRunner,
  getActiveSessions,
  getHealth,
  getIndexStats,
  getOverview,
  getPerformanceMetrics,
  getSlowQueries,
  getStorageStats,
  getTableStats,
} from "@/lib/db/providers/sql/athena/introspect";
import {
  type AthenaExecutionSummary,
  type AthenaTable,
  type AthenaTableListing,
  AthenaTransportError,
  type AthenaWorkgroupInfo,
} from "@/lib/db/providers/sql/athena/transport";

const NOW = new Date("2026-09-17T12:00:00.000Z");

const WORKGROUP: AthenaWorkgroupInfo = {
  name: "primary",
  state: "ENABLED",
  engineVersion: "Athena engine version 3",
  outputLocation: "s3://lake-results/",
  enforcesConfiguration: false,
  bytesScannedCutoff: null,
};

function execution(overrides: Partial<AthenaExecutionSummary> = {}): AthenaExecutionSummary {
  return {
    queryExecutionId: "11111111-2222-4333-8444-555555555555",
    statement: "SELECT 1",
    state: "SUCCEEDED",
    database: "analytics",
    workgroup: "primary",
    submittedAt: new Date("2026-09-17T11:59:00.000Z"),
    completedAt: new Date("2026-09-17T11:59:02.000Z"),
    engineMs: 1500,
    queuedMs: 100,
    scannedBytes: 2048,
    ...overrides,
  };
}

function table(name: string, parameters: Record<string, string> = {}): AthenaTable {
  return {
    name,
    tableType: "EXTERNAL_TABLE",
    columns: [{ name: "id", type: "bigint" }],
    partitionKeys: [],
    parameters,
  };
}

interface RunnerScript {
  workgroup?: AthenaWorkgroupInfo | Error;
  executions?: AthenaExecutionSummary[] | Error;
  listing?: AthenaTableListing | Error;
}

/** A runner answering from the script, recording what it was asked. */
function makeRunner(script: RunnerScript = {}): AthenaMonitoringRunner & { asked: string[] } {
  const asked: string[] = [];
  const answer = <T>(value: T | Error | undefined, fallback: T): Promise<T> => {
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? fallback);
  };
  return {
    asked,
    describeWorkgroup: () => {
      asked.push("workgroup");
      return answer(script.workgroup, WORKGROUP);
    },
    listExecutions: (limit) => {
      asked.push(`executions:${limit}`);
      return answer(script.executions, []);
    },
    listTables: (database, limit) => {
      asked.push(`tables:${database}:${limit}`);
      return answer(script.listing, { tables: [], truncated: false });
    },
  };
}

const DENIED = new AthenaTransportError("auth", "not authorized", "AccessDeniedException");

describe("getOverview", () => {
  test("reports the engine version, the statements in flight and the pinned database's table count", async () => {
    const runner = makeRunner({
      executions: [execution({ state: "RUNNING" }), execution({ state: "QUEUED" }), execution()],
      listing: { tables: [table("orders"), table("customers")], truncated: false },
    });

    const overview = await getOverview(runner, "analytics");

    expect(overview).toEqual({
      version: "Athena engine version 3",
      uptime: ATHENA_UNAVAILABLE_TEXT,
      activeConnections: 2,
      maxConnections: 0,
      databaseSize: ATHENA_UNAVAILABLE_TEXT,
      tableCount: 2,
      indexCount: 0,
    });
    expect(runner.asked).toContain(`executions:${ATHENA_HISTORY_WINDOW}`);
    expect(runner.asked).toContain(`tables:analytics:${ATHENA_MAX_STATS_TABLES}`);
  });

  // The service is serverless: an uptime and a size are readings that cannot exist,
  // and the keys that could carry a fabricated zero stay absent.
  test("states no size in bytes and no start time at all", async () => {
    const overview = await getOverview(makeRunner(), "analytics");

    expect("databaseSizeBytes" in overview).toBe(false);
    expect("startTime" in overview).toBe(false);
  });

  test("asks for no table count when the connection pins no database", async () => {
    const runner = makeRunner();
    const overview = await getOverview(runner, undefined);

    expect(overview.tableCount).toBe(0);
    expect(runner.asked.some((call) => call.startsWith("tables:"))).toBe(false);
  });

  test("survives a policy that withholds the workgroup and the history, losing only what they own", async () => {
    const overview = await getOverview(makeRunner({ workgroup: DENIED, executions: DENIED }), undefined);

    expect(overview.version).toBe(ATHENA_UNKNOWN_TEXT);
    expect(overview.activeConnections).toBe(0);
  });

  test("reports unknown for a workgroup that names no engine version", async () => {
    const overview = await getOverview(makeRunner({ workgroup: { ...WORKGROUP, engineVersion: null } }), undefined);

    expect(overview.version).toBe(ATHENA_UNKNOWN_TEXT);
  });

  // Only a withheld permission degrades. A throttle or an unreachable endpoint hidden
  // behind an empty panel would be hidden forever.
  test("propagates a failure that is not a withheld permission", async () => {
    const runner = makeRunner({ executions: new AthenaTransportError("resources", "throttled") });

    await expect(getOverview(runner, undefined)).rejects.toThrow("throttled");
  });
});

describe("getPerformanceMetrics", () => {
  test("reports no metric at all, because none of them is measured here", async () => {
    expect(await getPerformanceMetrics()).toEqual({});
  });
});

describe("getSlowQueries", () => {
  test("ranks completed statements by engine time, one execution per row", async () => {
    const runner = makeRunner({
      executions: [
        execution({ queryExecutionId: "a", engineMs: 100 }),
        execution({ queryExecutionId: "b", engineMs: 9000, statement: "SELECT big" }),
        execution({ queryExecutionId: "c", state: "FAILED", engineMs: 99999 }),
        execution({ queryExecutionId: "d", engineMs: null }),
        execution({ queryExecutionId: "e", state: "RUNNING", engineMs: 50 }),
      ],
    });

    const slow = await getSlowQueries(runner);

    expect(slow).toEqual([
      { queryId: "b", query: "SELECT big", calls: 1, totalTime: 9000, avgTime: 9000, rows: 0 },
      { queryId: "a", query: "SELECT 1", calls: 1, totalTime: 100, avgTime: 100, rows: 0 },
    ]);
  });

  test("caps the panel at the caller's limit, and at the default when the caller names none", async () => {
    const executions = Array.from({ length: 30 }, (_, at) => execution({ queryExecutionId: `q${at}`, engineMs: at }));
    const runner = makeRunner({ executions });

    expect((await getSlowQueries(runner, { limit: 3 })).map((row) => row.queryId)).toEqual(["q29", "q28", "q27"]);
    expect((await getSlowQueries(runner)).length).toBe(ATHENA_DEFAULT_SLOW_QUERY_LIMIT);
    // A nonsensical limit falls back rather than answering nothing.
    expect((await getSlowQueries(runner, { limit: 0 })).length).toBe(ATHENA_DEFAULT_SLOW_QUERY_LIMIT);
  });

  test("answers an empty panel when the policy withholds the history", async () => {
    expect(await getSlowQueries(makeRunner({ executions: DENIED }))).toEqual([]);
  });

  test("never reports a negative engine time", async () => {
    const runner = makeRunner({ executions: [execution({ engineMs: -5 })] });

    expect((await getSlowQueries(runner))[0].totalTime).toBe(0);
  });
});

describe("getActiveSessions", () => {
  test("lists the statements in flight, oldest first, with the service's own timestamps", async () => {
    const runner = makeRunner({
      executions: [
        execution({
          queryExecutionId: "newer",
          state: "RUNNING",
          submittedAt: new Date("2026-09-17T11:59:30.000Z"),
          completedAt: null,
        }),
        execution({
          queryExecutionId: "older",
          state: "QUEUED",
          submittedAt: new Date("2026-09-17T11:58:00.000Z"),
          completedAt: null,
        }),
        execution({ queryExecutionId: "done" }),
      ],
    });

    const sessions = await getActiveSessions(runner, {}, NOW);

    expect(sessions.map((session) => session.pid)).toEqual(["older", "newer"]);
    expect(sessions[0]).toEqual({
      pid: "older",
      user: "",
      database: "analytics",
      applicationName: "primary",
      state: "QUEUED",
      query: "SELECT 1",
      queryStart: new Date("2026-09-17T11:58:00.000Z"),
      duration: "2.00m",
      durationMs: 120_000,
    });
  });

  // An in-flight statement has no completion instant, so the span is measured to
  // `now`; one the service never stamped at all has no span to measure.
  test("leaves the fields the service did not record absent, and measures no span without a start", async () => {
    const runner = makeRunner({
      executions: [
        execution({ state: "RUNNING", database: null, workgroup: null, submittedAt: null, completedAt: null }),
      ],
    });

    const [session] = await getActiveSessions(runner, {}, NOW);

    expect(session.database).toBe("");
    expect("applicationName" in session).toBe(false);
    expect("queryStart" in session).toBe(false);
    expect(session.durationMs).toBe(0);
  });

  test("sorts a statement with no submission instant first, as the oldest it could be", async () => {
    const runner = makeRunner({
      executions: [
        execution({ queryExecutionId: "stamped", state: "RUNNING" }),
        execution({ queryExecutionId: "unstamped", state: "RUNNING", submittedAt: null }),
      ],
    });

    expect((await getActiveSessions(runner, {}, NOW)).map((session) => session.pid)).toEqual(["unstamped", "stamped"]);
  });

  test("caps the panel at the caller's limit, and at the default when the caller names none", async () => {
    const executions = Array.from({ length: 60 }, (_, at) =>
      execution({ queryExecutionId: `q${at}`, state: "RUNNING" }),
    );
    const runner = makeRunner({ executions });

    expect((await getActiveSessions(runner, { limit: 2 })).length).toBe(2);
    expect((await getActiveSessions(runner)).length).toBe(ATHENA_DEFAULT_SESSION_LIMIT);
  });

  test("uses a completed statement's own completion instant when it has one", async () => {
    const runner = makeRunner({
      executions: [
        execution({
          state: "RUNNING",
          submittedAt: new Date("2026-09-17T11:00:00.000Z"),
          completedAt: new Date("2026-09-17T11:00:05.000Z"),
        }),
      ],
    });

    expect((await getActiveSessions(runner, {}, NOW))[0].durationMs).toBe(5_000);
  });
});

describe("getTableStats", () => {
  test("reads the row count and size a crawler or an engine left in the catalog", async () => {
    const runner = makeRunner({
      listing: {
        tables: [
          table("crawled", { recordCount: "1200", sizeKey: "4096" }),
          table("written", { numRows: "30", totalSize: "512" }),
          table("counted-only", { numRows: "7" }),
          table("uncounted", { averageRecordSize: "12" }),
          table("garbage", { numRows: "many", totalSize: "-1" }),
        ],
        truncated: false,
      },
    });

    const reading = await getTableStats(runner, "analytics");

    expect(reading.refusal).toBeUndefined();
    expect(reading.tables).toEqual([
      {
        schemaName: "analytics",
        tableName: "crawled",
        rowCount: 1200,
        tableSize: "4 KB",
        tableSizeBytes: 4096,
        totalSize: "4 KB",
        totalSizeBytes: 4096,
      },
      {
        schemaName: "analytics",
        tableName: "written",
        rowCount: 30,
        tableSize: "512 B",
        tableSizeBytes: 512,
        totalSize: "512 B",
        totalSizeBytes: 512,
      },
      {
        schemaName: "analytics",
        tableName: "counted-only",
        rowCount: 7,
        totalSize: ATHENA_UNAVAILABLE_TEXT,
        totalSizeBytes: 0,
      },
    ]);
  });

  // `numRows` first: it is the engine's own figure, and a crawler's `recordCount` may
  // predate the last write.
  test("prefers the engine's row count over the crawler's when both are present", async () => {
    const runner = makeRunner({
      listing: { tables: [table("t", { numRows: "5", recordCount: "9" })], truncated: false },
    });

    expect((await getTableStats(runner, "analytics")).tables[0].rowCount).toBe(5);
  });

  test("skips a count too wide for a double rather than rounding it", async () => {
    const runner = makeRunner({
      listing: { tables: [table("t", { numRows: "99999999999999999999" })], truncated: false },
    });

    expect((await getTableStats(runner, "analytics")).tables).toEqual([]);
  });

  test("narrows to the schema the caller asked for, over the pinned database", async () => {
    const runner = makeRunner({ listing: { tables: [], truncated: false } });

    await getTableStats(runner, "analytics", { schema: "staging" });

    expect(runner.asked).toEqual([`tables:staging:${ATHENA_MAX_STATS_TABLES}`]);
  });

  test("refuses with the reason when the connection pins no database and the caller names none", async () => {
    const runner = makeRunner();
    const reading = await getTableStats(runner, undefined);

    expect(reading.tables).toEqual([]);
    expect(reading.refusal).toContain("pins no Athena database");
    expect(runner.asked).toEqual([]);
  });

  test("refuses a database over the listing ceiling rather than sampling it", async () => {
    const runner = makeRunner({ listing: { tables: [table("t", { numRows: "1" })], truncated: true } });
    const reading = await getTableStats(runner, "analytics");

    expect(reading.tables).toEqual([]);
    expect(reading.refusal).toContain(`more than ${ATHENA_MAX_STATS_TABLES} tables`);
  });

  test("refuses with the reason when tables exist and none carries a count", async () => {
    const runner = makeRunner({ listing: { tables: [table("a"), table("b")], truncated: false } });
    const reading = await getTableStats(runner, "analytics");

    expect(reading.tables).toEqual([]);
    expect(reading.refusal).toContain("None of the 2 tables");
    expect(reading.refusal).toContain("recordCount");
  });

  // A database holding no table is a measurement, and it renders as one.
  test("answers an empty measurement for a database that holds no table", async () => {
    expect(await getTableStats(makeRunner({ listing: { tables: [], truncated: false } }), "analytics")).toEqual({
      tables: [],
    });
  });

  test("propagates a refused listing, because the tree reads the same one", async () => {
    await expect(getTableStats(makeRunner({ listing: DENIED }), "analytics")).rejects.toThrow("not authorized");
  });
});

describe("the reads that ask the service nothing", () => {
  test("report no indexes and no storage rows", () => {
    expect(getIndexStats()).toEqual([]);
    expect(getStorageStats()).toEqual([]);
  });
});

describe("getHealth", () => {
  test("composes the summary from the reads that have a source", async () => {
    const runner = makeRunner({
      executions: [execution({ state: "RUNNING", statement: "SELECT running" }), execution({ engineMs: 42 })],
    });

    const health = await getHealth(runner, "analytics");

    expect(health.activeConnections).toBe(1);
    expect(health.databaseSize).toBe(ATHENA_UNAVAILABLE_TEXT);
    expect(health.cacheHitRatio).toBe(ATHENA_UNAVAILABLE_TEXT);
    expect(health.slowQueries).toEqual([{ query: "SELECT 1", calls: 1, avgTime: "42ms" }]);
    expect(health.activeSessions).toHaveLength(1);
    expect(health.activeSessions[0]).toMatchObject({ query: "SELECT running", state: "RUNNING", user: "" });
  });
});
