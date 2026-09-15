import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerStorageProvider } from "@/lib/storage/types";
import { logger } from "@/lib/logger";

// ── Mock pg ──────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = mock(async (..._args: any[]): Promise<any> => ({ rows: [] }));
const mockRelease = mock(() => {});
const mockEnd = mock(async () => {});

const mockClient = {
  query: mockQuery,
  release: mockRelease,
};

/**
 * A real EventEmitter, fresh per construction, mirroring what `pg` hands back. An `error`
 * event with no listener is an uncaught exception (#298), and this pool is long-lived —
 * it serves every request while STORAGE_PROVIDER=postgres — so an inert `on` in the mock
 * would hide exactly the crash this suite has to pin.
 */
function createMockPool(): EventEmitter & Record<string, any> {
  const pool = new EventEmitter() as EventEmitter & Record<string, any>;
  pool.query = mockQuery;
  pool.connect = mock(async () => mockClient);
  pool.end = mockEnd;
  return pool;
}

let mockPool = createMockPool();

const mockPoolConstructor = mock(() => {
  mockPool = createMockPool();
  return mockPool;
});

mock.module("pg", () => ({
  Pool: mockPoolConstructor,
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { PostgresStorageProvider } from "@/lib/storage/providers/postgres";

describe("PostgresStorageProvider", () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    mockQuery.mockClear();
    mockEnd.mockClear();
    mockRelease.mockClear();
    mockPoolConstructor.mockClear();
    provider = new PostgresStorageProvider("postgresql://localhost:5432/test");
  });

  afterEach(async () => {
    await provider.close();
  });

  test("initialize creates the user table, the audit table and its index", async () => {
    await provider.initialize();
    // user_storage, the audit table and its four indexes (§4.2, §4.27), the approval table and its index (§4.6), the job table and its index (§4.40).
    expect(mockQuery).toHaveBeenCalledTimes(10);
    const sql = (mockQuery.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sql[0]).toContain("CREATE TABLE IF NOT EXISTS user_storage");
    expect(sql[1]).toContain("CREATE TABLE IF NOT EXISTS audit_events");
    expect(sql[2]).toContain("CREATE INDEX IF NOT EXISTS audit_events_ts");
    expect(sql[3]).toContain("audit_events_type_ts ON audit_events (type, ts DESC)");
    expect(sql[4]).toContain("audit_events_actor ON audit_events ((data::jsonb->>'user'))");
    expect(sql[5]).toContain("audit_events_connection ON audit_events ((data::jsonb->>'connectionName'))");
  });

  // docs/CONTEXT.md §4.2: the durable audit record. Append-only by contract - the one write
  // is an INSERT that does nothing on a duplicate id, and no method updates or deletes.
  describe("the audit record", () => {
    const event = {
      id: "evt-1",
      timestamp: "2026-09-13T00:00:00.000Z",
      type: "query_execution" as const,
      action: "query",
      target: "POST /api/db/query",
      user: "ana",
      result: "success" as const,
    };

    test("appendAuditEvent inserts the event as JSON under its own id, never overwriting", async () => {
      await provider.initialize();
      mockQuery.mockClear();
      await provider.appendAuditEvent(event);
      const [sql, params] = (mockQuery.mock.calls as unknown[][])[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO audit_events");
      expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
      expect(sql).not.toMatch(/UPDATE|DELETE/);
      expect(params).toEqual(["evt-1", event.timestamp, "query_execution", JSON.stringify(event)]);
    });

    test("listAuditEvents reads newest first, optionally of one type, and parses the rows", async () => {
      await provider.initialize();
      mockQuery.mockImplementation(async () => ({ rows: [{ data: JSON.stringify(event) }] }));
      expect(await provider.listAuditEvents({ limit: 5 })).toEqual([event]);
      let [sql, params] = (mockQuery.mock.calls as unknown[][]).at(-1) as [string, unknown[]];
      expect(sql).toContain("ORDER BY ts DESC LIMIT $1 OFFSET $2");
      expect(params).toEqual([5, 0]);

      await provider.listAuditEvents({ type: "maintenance", limit: 2 });
      [sql, params] = (mockQuery.mock.calls as unknown[][]).at(-1) as [string, unknown[]];
      expect(sql).toContain("WHERE type = $1");
      expect(params).toEqual(["maintenance", 2, 0]);
      // docs/CONTEXT.md §4.27: every filter is a bound clause; the JSON fields read from the JSON.
      await provider.listAuditEvents({
        actor: "ana",
        connectionName: "Orders",
        result: "failure",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-14T00:00:00.000Z",
        limit: 10,
        offset: 20,
      });
      [sql, params] = (mockQuery.mock.calls as unknown[][]).at(-1) as [string, unknown[]];
      expect(sql).toContain(
        "WHERE data::jsonb->>'user' = $1 AND data::jsonb->>'connectionName' = $2 AND data::jsonb->>'result' = $3 AND ts >= $4 AND ts <= $5 ORDER BY ts DESC LIMIT $6 OFFSET $7",
      );
      expect(params).toEqual([
        "ana",
        "Orders",
        "failure",
        "2026-09-01T00:00:00.000Z",
        "2026-09-14T00:00:00.000Z",
        10,
        20,
      ]);
    });

    test("countAuditEvents answers the count, and 0 for an empty answer", async () => {
      await provider.initialize();
      mockQuery.mockImplementation(async () => ({ rows: [{ n: 42 }] }));
      expect(await provider.countAuditEvents()).toBe(42);
      expect(await provider.countAuditEvents({ type: "maintenance", from: "2026-09-01T00:00:00.000Z" })).toBe(42);
      const [sql, params] = (mockQuery.mock.calls as unknown[][]).at(-1) as [string, unknown[]];
      expect(sql).toContain("FROM audit_events WHERE type = $1 AND ts >= $2");
      expect(params).toEqual(["maintenance", "2026-09-01T00:00:00.000Z"]);
      mockQuery.mockImplementation(async () => ({ rows: [] }));
      expect(await provider.countAuditEvents()).toBe(0);
    });

    // docs/CONTEXT.md §4.12: retention is the one delete the append-only table allows.
    test("pruneAuditEvents deletes what is older than the instant and answers the count, 0 when the driver gives none", async () => {
      await provider.initialize();
      mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 12 }));
      expect(await provider.pruneAuditEvents("2026-06-01T00:00:00.000Z")).toBe(12);
      const [sql, params] = mockQuery.mock.calls.at(-1) as [string, unknown[]];
      expect(sql).toContain("DELETE FROM audit_events WHERE ts < $1");
      expect(params).toEqual(["2026-06-01T00:00:00.000Z"]);
      mockQuery.mockImplementation(async () => ({ rows: [] }));
      expect(await provider.pruneAuditEvents("2026-06-01T00:00:00.000Z")).toBe(0);
    });

    test("every audit method refuses before initialize()", async () => {
      await expect(provider.appendAuditEvent(event)).rejects.toThrow("not initialized");
      await expect(provider.listAuditEvents({ limit: 1 })).rejects.toThrow("not initialized");
      await expect(provider.countAuditEvents()).rejects.toThrow("not initialized");
      await expect(provider.pruneAuditEvents("x")).rejects.toThrow("not initialized");
    });
  });

  test("initialize disables SSL for localhost when no ssl params", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://localhost:5432/test");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("initialize disables SSL when sslmode=disable", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://localhost:5432/test?sslmode=disable");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("initialize disables SSL for docker local host aliases", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://host.docker.internal:5432/test");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("initialize enables SSL when sslmode=require", async () => {
    const cloudProvider = new PostgresStorageProvider("postgresql://db.example.com:5432/test?sslmode=require");
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    await cloudProvider.close();
  });

  // D26: `verify-system` is this product's own mode name, and STORAGE_POSTGRES_URL is read
  // for libpq's sslmode - so a URL naming it used to fall through every branch and land on
  // the non-local default, `rejectUnauthorized: false`. Someone who typed the verifying mode
  // got no verification and no complaint. It is now the one value in this reader that
  // actually verifies.
  test("initialize verifies the chain when the URL names the form's verify-system mode", async () => {
    const cloudProvider = new PostgresStorageProvider("postgresql://db.example.com:5432/test?sslmode=verify-system");
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: true });
    await cloudProvider.close();
  });

  test("initialize enables SSL for non-local hosts by default", async () => {
    const cloudProvider = new PostgresStorageProvider("postgresql://db.internal.example:5432/test");
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    await cloudProvider.close();
  });

  test("initialize disables SSL for all loopback 127.x.x.x addresses", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://127.0.0.42:5432/test");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("getAllData returns parsed collections", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { collection: "connections", data: JSON.stringify([{ id: "c1" }]) },
        { collection: "history", data: JSON.stringify([{ id: "h1" }]) },
      ],
    });

    const result = await provider.getAllData("admin@test.com");
    expect(result.connections as unknown).toEqual([{ id: "c1" }]);
    expect(result.history as unknown).toEqual([{ id: "h1" }]);
  });

  test("getCollection returns null when not found", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result).toBeNull();
  });

  test("getCollection returns parsed data", async () => {
    const data = [{ id: "c1", name: "Test" }];
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [{ data: JSON.stringify(data) }],
    });

    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result as unknown).toEqual(data);
  });

  test("setCollection calls INSERT with ON CONFLICT", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await provider.setCollection("admin@test.com", "connections", []);

    const calls = mockQuery.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    const sql = lastCall[0] as string;
    expect(sql).toContain("INSERT INTO user_storage");
    expect(sql).toContain("ON CONFLICT");
  });

  test("persists exactly JSON.stringify of what it was given, adding and hiding nothing", async () => {
    // Same reasoning as the SQLite twin: the threat test's claim about the store depends on the
    // provider being a faithful serializer.
    await provider.initialize();
    mockQuery.mockClear();
    const data = [{ id: "c1", name: "Prod", type: "postgres", password: "v1:aaa:bbb" }];

    await provider.setCollection("u@example.org", "connections", data as never);

    const [, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(params).toEqual(["u@example.org", "connections", JSON.stringify(data)]);
  });

  test("isHealthy returns true on success", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    expect(await provider.isHealthy()).toBe(true);
  });

  test("isHealthy returns false on error", async () => {
    await provider.initialize();
    mockQuery.mockRejectedValueOnce(new Error("Connection lost"));

    expect(await provider.isHealthy()).toBe(false);
  });

  test("close calls pool.end()", async () => {
    await provider.initialize();
    await provider.close();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test("mergeData uses transaction", async () => {
    await provider.initialize();

    const mockClientQuery = mock(async (): Promise<{ rows: unknown[] }> => ({ rows: [] }));
    const client = {
      query: mockClientQuery,
      release: mock(() => {}),
    };
    mockPool.connect = mock(async () => client);

    await provider.mergeData("admin@test.com", {
      connections: [
        { id: "c1", name: "Test", type: "postgres", createdAt: new Date() } as import("@/lib/types").DatabaseConnection,
      ],
    });

    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[queries.length - 1]).toBe("COMMIT");
  });

  test("mergeData rolls back on error and releases client", async () => {
    await provider.initialize();

    let callCount = 0;
    const mockClientQuery = mock(async (sql: string): Promise<{ rows: unknown[] }> => {
      callCount++;
      // Fail on the INSERT (3rd call: BEGIN, then INSERT fails)
      if (callCount === 2) throw new Error("Insert failed");
      return { rows: [] };
    });
    const mockClientRelease = mock(() => {});
    const client = {
      query: mockClientQuery,
      release: mockClientRelease,
    };
    mockPool.connect = mock(async () => client);

    await expect(
      provider.mergeData("admin@test.com", {
        connections: [
          {
            id: "c1",
            name: "Test",
            type: "postgres",
            createdAt: new Date(),
          } as import("@/lib/types").DatabaseConnection,
        ],
      }),
    ).rejects.toThrow("Insert failed");

    // ROLLBACK should have been called
    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(queries).toContain("ROLLBACK");
    // Client always released (finally block)
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  test("mergeData only writes provided collections", async () => {
    await provider.initialize();

    const mockClientQuery = mock(async (): Promise<{ rows: unknown[] }> => ({ rows: [] }));
    const client = {
      query: mockClientQuery,
      release: mock(() => {}),
    };
    mockPool.connect = mock(async () => client);

    await provider.mergeData("admin@test.com", {
      connections: [
        { id: "c1", name: "Test", type: "postgres", createdAt: new Date() } as import("@/lib/types").DatabaseConnection,
      ],
    });

    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    // BEGIN + 1 INSERT + COMMIT = 3 queries
    expect(queries.length).toBe(3);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("INSERT INTO user_storage");
    expect(queries[2]).toBe("COMMIT");
  });

  test("getCollection returns null for corrupted JSON", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [{ data: "invalid-json{{{" }],
    });

    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result).toBeNull();
  });

  test("getAllData skips corrupted JSON rows", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { collection: "connections", data: JSON.stringify([{ id: "c1" }]) },
        { collection: "history", data: "corrupted{{{" },
      ],
    });

    const result = await provider.getAllData("admin@test.com");
    expect(result.connections as unknown).toEqual([{ id: "c1" }]);
    expect(result.history).toBeUndefined();
  });

  test("initialize throws when no connection string", async () => {
    const origEnv = process.env.STORAGE_POSTGRES_URL;
    delete process.env.STORAGE_POSTGRES_URL;
    try {
      const noUrlProvider = new PostgresStorageProvider("");
      await expect(noUrlProvider.initialize()).rejects.toThrow("STORAGE_POSTGRES_URL is required");
    } finally {
      if (origEnv !== undefined) process.env.STORAGE_POSTGRES_URL = origEnv;
    }
  });

  test("close on uninitialized provider does not throw", async () => {
    const freshProvider = new PostgresStorageProvider("postgresql://localhost/test");
    await expect(freshProvider.close()).resolves.toBeUndefined();
  });

  test("ensurePool throws when not initialized", async () => {
    const freshProvider = new PostgresStorageProvider("postgresql://localhost/test");
    await expect(freshProvider.getAllData("test@test.com")).rejects.toThrow("not initialized");
  });

  // ── Pool error events (#298) ───────────────────────────────────────────────

  test("an idle client error on the storage pool is logged and does not escalate", async () => {
    await provider.initialize();
    const idleFailure = new Error("Connection terminated unexpectedly");
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    // Another test file replaces `@/lib/logger` wholesale, and spying on a method that is
    // already a mock reuses that mock — call history from the rest of the process comes
    // with it. Clear it so the count below is this test's own.
    errorSpy.mockClear();

    try {
      // `pg` destroys the idle client and emits on the POOL; an `error` event with no
      // listener is an uncaught exception, i.e. a dead server process.
      expect(() => mockPool.emit("error", idleFailure)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, loggedError, context] = errorSpy.mock.calls[0] as [string, unknown, unknown];
      expect(message).toContain("pool");
      expect(loggedError).toBe(idleFailure);
      expect(context).toEqual({ provider: "postgres" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("the storage pool carries exactly one error listener", async () => {
    await provider.initialize();
    expect(mockPool.listenerCount("error")).toBe(1);
  });

  // docs/CONTEXT.md §4.6: the approval record; see the SQLite suite for the contract.
  describe("write approvals", () => {
    const record = {
      id: "req-1",
      datasourceId: "orders",
      datasourceName: "Orders",
      requester: "ana",
      statement: "DELETE FROM t",
      route: "POST /api/db/query",
      status: "pending" as const,
      requestedAt: "2026-09-13T00:00:00.000Z",
    };

    test("initialize creates the approval_requests table and its lookup index", async () => {
      await provider.initialize();
      const ddl = (mockQuery.mock.calls as unknown[][]).map((c) => c[0] as string).join("\n");
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS approval_requests");
      expect(ddl).toContain("approval_requests_lookup");
    });

    test("putApproval upserts the record with its filter columns", async () => {
      await provider.initialize();
      mockQuery.mockClear();
      await provider.putApproval(record);
      const [sql, params] = (mockQuery.mock.calls as unknown[][])[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO approval_requests");
      expect(sql).toContain("ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data");
      expect(params).toEqual(["req-1", record.requestedAt, "pending", "ana", "orders", JSON.stringify(record)]);
    });

    test("getApproval parses the row and answers null for an unknown id", async () => {
      await provider.initialize();
      mockQuery.mockImplementation(async () => ({ rows: [{ data: JSON.stringify(record) }] }));
      expect(await provider.getApproval("req-1")).toEqual(record);
      mockQuery.mockImplementation(async () => ({ rows: [] }));
      expect(await provider.getApproval("nope")).toBeNull();
    });

    test("listApprovals numbers the placeholders for whichever filters are given, newest first", async () => {
      await provider.initialize();
      mockQuery.mockImplementation(async () => ({ rows: [{ data: JSON.stringify(record) }] }));
      expect(await provider.listApprovals({ limit: 5 })).toEqual([record]);
      let [sql, params] = (mockQuery.mock.calls as unknown[][]).at(-1) as [string, unknown[]];
      expect(sql).toBe("SELECT data FROM approval_requests ORDER BY ts DESC LIMIT $1");
      expect(params).toEqual([5]);
      await provider.listApprovals({ requester: "ana", datasourceId: "orders", limit: 2 });
      [sql, params] = (mockQuery.mock.calls as unknown[][]).at(-1) as [string, unknown[]];
      expect(sql).toContain("WHERE requester = $1 AND datasource_id = $2 ORDER BY ts DESC LIMIT $3");
      expect(params).toEqual(["ana", "orders", 2]);
    });

    test("every approval method refuses before initialize()", async () => {
      await expect(provider.putApproval(record)).rejects.toThrow("not initialized");
      await expect(provider.getApproval("x")).rejects.toThrow("not initialized");
      await expect(provider.listApprovals({ limit: 1 })).rejects.toThrow("not initialized");
    });
  });

  // docs/CONTEXT.md §4.40: the job queue - the record as JSON with the claimable columns beside it.
  describe("jobs", () => {
    const job = {
      id: "j1",
      kind: "ping",
      payload: { echo: "hi" },
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 2,
      requestedBy: "root",
      createdAt: "2026-09-14T00:00:00.000Z",
      runAt: "2026-09-14T00:00:00.000Z",
    };
    const row = (over: Record<string, unknown> = {}) => ({
      id: "j1",
      kind: "ping",
      status: "running",
      run_at: new Date("2026-09-14T00:00:00.000Z"),
      lease_until: new Date("2026-09-14T00:01:00.000Z"),
      attempts: 1,
      max_attempts: 2,
      worker: "w:1",
      data: JSON.stringify(job),
      ...over,
    });

    test("putJob upserts every claimable column and the record; getJob lays the columns over the record", async () => {
      await provider.initialize();
      mockQuery.mockClear();
      await provider.putJob(job);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO jobs");
      expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
      expect(params).toEqual(["j1", "ping", "queued", job.runAt, null, 0, 2, null, JSON.stringify(job)]);
      mockQuery.mockResolvedValueOnce({ rows: [row()] });
      expect(await provider.getJob("j1")).toEqual({
        ...job,
        status: "running",
        leaseUntil: "2026-09-14T00:01:00.000Z",
        attempts: 1,
        worker: "w:1",
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await provider.getJob("ghost")).toBeNull();
    });

    test("listJobs filters by what is given and bounds the list; countJobs counts one status", async () => {
      await provider.initialize();
      mockQuery.mockClear();
      mockQuery.mockResolvedValueOnce({ rows: [row({ lease_until: null, worker: null })] });
      const listed = await provider.listJobs({ status: "queued", kind: "ping", limit: 5 });
      expect(listed[0]).toMatchObject({ id: "j1", leaseUntil: undefined, worker: undefined });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("WHERE status = $1 AND kind = $2 ORDER BY run_at DESC LIMIT $3");
      expect(params).toEqual(["queued", "ping", 5]);
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await provider.listJobs({ limit: 10 });
      expect((mockQuery.mock.calls[1] as [string])[0]).toContain("FROM jobs ORDER BY run_at DESC LIMIT $1");
      mockQuery.mockResolvedValueOnce({ rows: [{ n: 3 }] });
      expect(await provider.countJobs("queued")).toBe(3);
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await provider.countJobs("lost")).toBe(0);
    });

    test("claimJob takes one due job of the kinds asked with SKIP LOCKED; heartbeatJob extends only this worker's lease; reclaimJobs frees or loses expired leases", async () => {
      await provider.initialize();
      mockQuery.mockClear();
      mockQuery.mockResolvedValueOnce({ rows: [row()] });
      const claimed = await provider.claimJob(
        ["ping", "export"],
        "w:1",
        "2026-09-14T00:00:30.000Z",
        "2026-09-14T00:01:00.000Z",
      );
      expect(claimed).toMatchObject({ id: "j1", status: "running", attempts: 1, worker: "w:1" });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(sql).toContain("kind = ANY($4)");
      expect(params).toEqual(["2026-09-14T00:00:30.000Z", "2026-09-14T00:01:00.000Z", "w:1", ["ping", "export"]]);
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await provider.claimJob(["ping"], "w:1", "x", "y")).toBeNull();
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
      expect(await provider.heartbeatJob("j1", "w:1", "2026-09-14T00:02:00.000Z")).toBe(true);
      expect((mockQuery.mock.calls[2] as [string, unknown[]])[1]).toEqual(["j1", "w:1", "2026-09-14T00:02:00.000Z"]);
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      expect(await provider.heartbeatJob("j1", "w:2", "x")).toBe(false);
      mockQuery.mockResolvedValueOnce({
        rows: [row({ status: "lost", lease_until: null, worker: null, attempts: 2 })],
      });
      const reclaimed = await provider.reclaimJobs("2026-09-14T00:05:00.000Z");
      expect(reclaimed[0]).toMatchObject({ status: "lost", attempts: 2, worker: undefined });
      expect((mockQuery.mock.calls[4] as [string])[0]).toContain(
        "CASE WHEN attempts >= max_attempts THEN 'lost' ELSE 'queued' END",
      );
    });

    // Retention (§4.40): only settled jobs go, and only those due before the instant given.
    test("pruneJobs deletes settled jobs due before the instant and answers how many", async () => {
      await provider.initialize();
      mockQuery.mockClear();
      mockQuery.mockResolvedValueOnce({ rowCount: 4, rows: [] });
      expect(await provider.pruneJobs("2026-09-07T00:00:00.000Z")).toBe(4);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("DELETE FROM jobs WHERE status IN ('done', 'failed', 'lost') AND run_at < $1");
      expect(params).toEqual(["2026-09-07T00:00:00.000Z"]);
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await provider.pruneJobs("x")).toBe(0);
    });
  });
});
