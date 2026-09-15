import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ServerStorageProvider } from "@/lib/storage/types";

// ── Mock better-sqlite3 ─────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrepare = mock((): any => ({
  all: mock((): any[] => []),
  get: mock((): any => undefined),
  run: mock((..._args: any[]) => {}),
}));
const mockExec = mock((..._args: any[]) => {});
const mockPragma = mock((..._args: any[]) => {});
const mockClose = mock(() => {});

const mockDbInstance = {
  prepare: mockPrepare,
  exec: mockExec,
  pragma: mockPragma,
  close: mockClose,
  transaction: mock((fn: () => void) => fn),
};

// When set, the mocked better-sqlite3 constructor throws this error - used to
// exercise the Node-ABI-mismatch guard in initialize().
let constructorError: Error | null = null;

mock.module("better-sqlite3", () => ({
  default: mock(() => {
    if (constructorError) throw constructorError;
    return mockDbInstance;
  }),
}));

// Mock fs and path for directory creation
mock.module("fs", () => ({
  existsSync: mock(() => true),
  mkdirSync: mock(() => {}),
}));

mock.module("path", () => ({
  dirname: mock((p: string) => p.replace(/\/[^/]*$/, "")),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { SQLiteStorageProvider } from "@/lib/storage/providers/sqlite";

describe("SQLiteStorageProvider", () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    mockPrepare.mockClear();
    mockExec.mockClear();
    mockPragma.mockClear();
    mockClose.mockClear();
    provider = new SQLiteStorageProvider(":memory:");
  });

  afterEach(async () => {
    await provider.close();
  });

  test("initialize creates table and enables WAL", async () => {
    await provider.initialize();
    expect(mockPragma).toHaveBeenCalledWith("journal_mode = WAL");
    // user_storage, the audit record (§4.2), the approval record (§4.6), the job queue (§4.40).
    expect(mockExec).toHaveBeenCalledTimes(4);
    expect((mockExec.mock.calls as unknown[][])[1][0] as string).toContain("CREATE TABLE IF NOT EXISTS audit_events");
    const sql = (mockExec.mock.calls as unknown[][])[0][0] as string;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS user_storage");
  });

  test("getAllData returns parsed collections", async () => {
    const mockRows = [
      { collection: "connections", data: JSON.stringify([{ id: "c1" }]) },
      { collection: "history", data: JSON.stringify([{ id: "h1" }]) },
    ];
    mockPrepare.mockReturnValue({
      all: mock(() => mockRows),
      get: mock(() => undefined),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getAllData("admin@test.com");

    expect(result.connections as unknown).toEqual([{ id: "c1" }]);
    expect(result.history as unknown).toEqual([{ id: "h1" }]);
  });

  test("getCollection returns null when not found", async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result).toBeNull();
  });

  test("getCollection returns parsed data", async () => {
    const data = [{ id: "c1", name: "Test" }];
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => ({ data: JSON.stringify(data) })),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result as unknown).toEqual(data);
  });

  test("setCollection calls INSERT OR REPLACE", async () => {
    const mockRun = mock((..._args: unknown[]) => {});
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mockRun,
    });

    await provider.initialize();
    await provider.setCollection("admin@test.com", "connections", []);

    expect(mockRun).toHaveBeenCalled();
    const args = (mockRun.mock.calls as unknown[][])[0];
    expect(args[0]).toBe("admin@test.com");
    expect(args[1]).toBe("connections");
  });

  test("persists exactly JSON.stringify of what it was given, adding and hiding nothing", async () => {
    // The credential-at-rest threat test asserts on what the DECORATOR hands a provider. That is
    // only a statement about the store if the provider is a faithful serializer, which is what
    // this pins: a provider that re-shaped, re-encoded or supplemented the value would break the
    // chain without any security test noticing.
    const run = mock(() => {});
    mockPrepare.mockImplementation(() => ({ all: mock(() => []), get: mock(() => undefined), run }));
    await provider.initialize();
    const data = [{ id: "c1", name: "Prod", type: "postgres", password: "v1:aaa:bbb" }];

    await provider.setCollection("u@example.org", "connections", data as never);

    expect(run).toHaveBeenCalledWith("u@example.org", "connections", JSON.stringify(data));
  });

  test("isHealthy returns true when db works", async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => ({ ok: 1 })),
      run: mock(() => {}),
    });

    await provider.initialize();
    expect(await provider.isHealthy()).toBe(true);
  });

  test("close calls db.close()", async () => {
    await provider.initialize();
    await provider.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test("mergeData uses transaction", async () => {
    const mockRun = mock((..._args: unknown[]) => {});
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mockRun,
    });

    const txFn = mock((fn: () => void) => fn);
    mockDbInstance.transaction = txFn;

    await provider.initialize();
    await provider.mergeData("admin@test.com", {
      connections: [
        { id: "c1", name: "DB", type: "postgres", host: "localhost", port: 5432, createdAt: new Date() },
      ] as import("@/lib/types").DatabaseConnection[],
      history: [
        {
          id: "h1",
          connectionId: "c1",
          query: "SELECT 1",
          executionTime: 10,
          status: "success",
          executedAt: new Date(),
        },
      ] as import("@/lib/types").QueryHistoryItem[],
    });

    // Transaction wrapper was called
    expect(txFn).toHaveBeenCalledTimes(1);
    // run was called for each provided collection
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("mergeData only writes provided collections", async () => {
    const mockRun = mock((..._args: unknown[]) => {});
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mockRun,
    });
    mockDbInstance.transaction = mock((fn: () => void) => fn);

    await provider.initialize();
    await provider.mergeData("admin@test.com", {
      connections: [
        { id: "c1", name: "DB", type: "postgres", host: "localhost", port: 5432, createdAt: new Date() },
      ] as import("@/lib/types").DatabaseConnection[],
    });

    // Only connections was provided, so only 1 run call for data
    expect(mockRun).toHaveBeenCalledTimes(1);
    const args = (mockRun.mock.calls as unknown[][])[0];
    expect(args[1]).toBe("connections");
  });

  test("isHealthy returns false on error", async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => {
        throw new Error("DB crashed");
      }),
      run: mock(() => {}),
    });

    await provider.initialize();
    expect(await provider.isHealthy()).toBe(false);
  });

  test("getCollection returns null for corrupted JSON", async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => ({ data: "not-valid-json{{{" })),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result).toBeNull();
  });

  test("getAllData skips corrupted JSON rows", async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => [
        { collection: "connections", data: JSON.stringify([{ id: "c1" }]) },
        { collection: "history", data: "corrupted{{{" },
      ]),
      get: mock(() => undefined),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getAllData("admin@test.com");
    expect(result.connections as unknown).toEqual([{ id: "c1" }]);
    expect(result.history).toBeUndefined();
  });

  test("close on uninitialized provider does not throw", async () => {
    const freshProvider = new SQLiteStorageProvider(":memory:");
    await expect(freshProvider.close()).resolves.toBeUndefined();
  });

  test("ensureDb throws when not initialized", async () => {
    const freshProvider = new SQLiteStorageProvider(":memory:");
    await expect(freshProvider.getAllData("test@test.com")).rejects.toThrow("not initialized");
  });

  describe("Node ABI mismatch guard", () => {
    afterEach(() => {
      constructorError = null;
    });

    // better-sqlite3 v13 is N-API, so a genuine ABI mismatch should no longer
    // be reachable through a normal install - this guard now covers a pinned
    // older better-sqlite3 or a half-copied node_modules. The mismatch is
    // reported in BOTH directions (an older runtime wants a lower
    // NODE_MODULE_VERSION, a newer one a higher), and the message has to be
    // true of both.
    test.each([
      [
        "an older runtime (wants NODE_MODULE_VERSION 127)",
        "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.",
      ],
      [
        "a newer runtime (wants NODE_MODULE_VERSION 147)",
        "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 147.",
      ],
    ])("translates the ABI mismatch reported by %s into an actionable message", async (_label, text) => {
      constructorError = new Error(text);
      const freshProvider = new SQLiteStorageProvider(":memory:");
      const error = await freshProvider.initialize().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toContain("different Node ABI");
      expect(error?.message).toContain("STORAGE_PROVIDER=postgres");
      expect(error?.message).toContain(text);
    });

    test("never states the ABI constraint as a version floor", async () => {
      // Regression guard for the defect this wording used to carry: it said
      // "requires Node.js 24+", which a Node 26 user reads as satisfied while
      // the module still refuses to load. A native binding's constraint is the
      // ABI it was built against, never a version floor.
      constructorError = new Error(
        "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 147.",
      );
      const freshProvider = new SQLiteStorageProvider(":memory:");
      const error = await freshProvider.initialize().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.message).not.toContain("24+");
      expect(error?.message).not.toMatch(/24 or newer/i);
    });

    test("does NOT claim an ABI mismatch for non-ABI dlopen failures (libc mismatch, missing libs)", async () => {
      // Realistic loader text for a glibc/musl mismatch: ERR_DLOPEN_FAILED and
      // the better_sqlite3.node path, but no NODE_MODULE_VERSION - the original
      // error must pass through untouched instead of a misleading Node-24 claim.
      const dlopenError = new Error(
        "libstdc++.so.6: cannot open shared object file: No such file or directory (required by /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node)",
      ) as Error & { code?: string };
      dlopenError.code = "ERR_DLOPEN_FAILED";
      constructorError = dlopenError;
      const freshProvider = new SQLiteStorageProvider(":memory:");
      const error = await freshProvider.initialize().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBe(dlopenError);
      expect(error?.message).not.toContain("different Node ABI");
    });

    test("keeps the friendly error's cause chained to the original", async () => {
      constructorError = new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 137");
      const freshProvider = new SQLiteStorageProvider(":memory:");
      const error = await freshProvider.initialize().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).not.toBeNull();
      expect(error?.cause).toBe(constructorError);
    });

    test("rethrows unrelated initialization errors untouched", async () => {
      constructorError = new Error("disk I/O error");
      const freshProvider = new SQLiteStorageProvider(":memory:");
      await expect(freshProvider.initialize()).rejects.toThrow("disk I/O error");
    });
  });

  // docs/CONTEXT.md §4.2: the durable audit record. Append-only by contract - the one write
  // is an INSERT OR IGNORE, and no method updates or deletes.
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
      const run = mock(() => {});
      mockPrepare.mockImplementationOnce(() => ({ run, all: mock(() => []), get: mock(() => undefined) }));
      await provider.appendAuditEvent(event);
      const sql = (mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string;
      expect(sql).toContain("INSERT OR IGNORE INTO audit_events");
      expect(sql).not.toMatch(/UPDATE|DELETE/);
      expect(run).toHaveBeenCalledWith("evt-1", event.timestamp, "query_execution", JSON.stringify(event));
    });

    test("listAuditEvents reads newest first, optionally of one type, and parses the rows", async () => {
      await provider.initialize();
      const all = mock(() => [{ data: JSON.stringify(event) }]);
      mockPrepare.mockImplementation(() => ({ all, run: mock(() => {}), get: mock(() => undefined) }));
      expect(await provider.listAuditEvents({ limit: 5 })).toEqual([event]);
      expect((mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string).toContain(
        "ORDER BY ts DESC LIMIT ? OFFSET ?",
      );
      expect(all).toHaveBeenLastCalledWith(5, 0);

      await provider.listAuditEvents({ type: "maintenance", limit: 2 });
      expect((mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string).toContain("WHERE type = ?");
      expect(all).toHaveBeenLastCalledWith("maintenance", 2, 0);
      // docs/CONTEXT.md §4.27: every filter is a bound clause; the JSON fields through json_extract.
      await provider.listAuditEvents({
        actor: "ana",
        connectionName: "Orders",
        result: "failure",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-14T00:00:00.000Z",
        limit: 10,
        offset: 20,
      });
      const sql = (mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string;
      expect(sql).toContain(
        "WHERE json_extract(data, '$.user') = ? AND json_extract(data, '$.connectionName') = ? AND json_extract(data, '$.result') = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ? OFFSET ?",
      );
      expect(all).toHaveBeenLastCalledWith(
        "ana",
        "Orders",
        "failure",
        "2026-09-01T00:00:00.000Z",
        "2026-09-14T00:00:00.000Z",
        10,
        20,
      );
    });

    test("countAuditEvents answers the count, and 0 for an empty answer", async () => {
      await provider.initialize();
      mockPrepare.mockImplementationOnce(() => ({
        get: mock(() => ({ n: 7 })),
        all: mock(() => []),
        run: mock(() => {}),
      }));
      expect(await provider.countAuditEvents()).toBe(7);
      const get = mock(() => ({ n: 2 }));
      mockPrepare.mockImplementationOnce(() => ({ get, all: mock(() => []), run: mock(() => {}) }));
      expect(await provider.countAuditEvents({ type: "maintenance", actor: "ana" })).toBe(2);
      expect((mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string).toContain(
        "FROM audit_events WHERE type = ? AND json_extract(data, '$.user') = ?",
      );
      expect(get).toHaveBeenCalledWith("maintenance", "ana");
      mockPrepare.mockImplementationOnce(() => ({
        get: mock(() => undefined),
        all: mock(() => []),
        run: mock(() => {}),
      }));
      expect(await provider.countAuditEvents()).toBe(0);
    });

    // docs/CONTEXT.md §4.12: retention is the one delete the append-only table allows.
    test("pruneAuditEvents deletes what is older than the instant and answers the driver's change count", async () => {
      await provider.initialize();
      const run = mock(() => ({ changes: 5 }));
      mockPrepare.mockImplementationOnce(() => ({ get: mock(() => undefined), all: mock(() => []), run }));
      expect(await provider.pruneAuditEvents("2026-06-01T00:00:00.000Z")).toBe(5);
      expect(String((mockPrepare.mock.calls.at(-1) as unknown[])[0])).toContain(
        "DELETE FROM audit_events WHERE ts < ?",
      );
      expect(run).toHaveBeenCalledWith("2026-06-01T00:00:00.000Z");
      // §4.43: SQLite has no partitions, so its upkeep is the prune alone, and nothing with no retention.
      mockPrepare.mockImplementationOnce(() => ({ get: mock(() => undefined), all: mock(() => []), run }));
      expect(await provider.maintainAuditStorage(new Date(), "2026-06-01T00:00:00.000Z")).toEqual({
        created: [],
        dropped: [],
        removed: 5,
      });
      expect(await provider.maintainAuditStorage(new Date(), null)).toEqual({ created: [], dropped: [], removed: 0 });
      mockPrepare.mockImplementationOnce(() => ({
        get: mock(() => undefined),
        all: mock(() => []),
        run: mock(() => ({})),
      }));
      expect(await provider.pruneAuditEvents("2026-06-01T00:00:00.000Z")).toBe(0);
    });

    test("every audit method refuses before initialize()", async () => {
      await expect(provider.appendAuditEvent(event)).rejects.toThrow("not initialized");
      await expect(provider.listAuditEvents({ limit: 1 })).rejects.toThrow("not initialized");
      await expect(provider.countAuditEvents()).rejects.toThrow("not initialized");
      await expect(provider.pruneAuditEvents("x")).rejects.toThrow("not initialized");
    });
  });

  // docs/CONTEXT.md §4.6: the approval record - written whole under its id, replaced on a
  // decision, read by id and by the three columns the gate and the reviewer list filter on.
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
      const ddl = (mockExec.mock.calls as unknown[][]).map((c) => c[0] as string).join("\n");
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS approval_requests");
      expect(ddl).toContain("approval_requests_lookup");
    });

    test("putApproval writes the record as JSON with its filter columns, replacing an earlier row", async () => {
      await provider.initialize();
      const run = mock(() => {});
      mockPrepare.mockImplementationOnce(() => ({ run, all: mock(() => []), get: mock(() => undefined) }));
      await provider.putApproval(record);
      expect((mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string).toContain(
        "INSERT OR REPLACE INTO approval_requests",
      );
      expect(run).toHaveBeenCalledWith("req-1", record.requestedAt, "pending", "ana", "orders", JSON.stringify(record));
    });

    test("getApproval parses the row and answers null for an unknown id", async () => {
      await provider.initialize();
      mockPrepare.mockImplementationOnce(() => ({
        get: mock(() => ({ data: JSON.stringify(record) })),
        all: mock(() => []),
        run: mock(() => {}),
      }));
      expect(await provider.getApproval("req-1")).toEqual(record);
      mockPrepare.mockImplementationOnce(() => ({
        get: mock(() => undefined),
        all: mock(() => []),
        run: mock(() => {}),
      }));
      expect(await provider.getApproval("nope")).toBeNull();
    });

    test("listApprovals builds the WHERE from whichever filters are given, newest first", async () => {
      await provider.initialize();
      const all = mock(() => [{ data: JSON.stringify(record) }]);
      mockPrepare.mockImplementation(() => ({ all, run: mock(() => {}), get: mock(() => undefined) }));
      expect(await provider.listApprovals({ limit: 5 })).toEqual([record]);
      expect((mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string).toBe(
        "SELECT data FROM approval_requests ORDER BY ts DESC LIMIT ?",
      );
      expect(all).toHaveBeenLastCalledWith(5);
      await provider.listApprovals({ status: "pending", requester: "ana", datasourceId: "orders", limit: 1 });
      expect((mockPrepare.mock.calls as unknown[][]).at(-1)![0] as string).toContain(
        "WHERE status = ? AND requester = ? AND datasource_id = ? ORDER BY ts DESC LIMIT ?",
      );
      expect(all).toHaveBeenLastCalledWith("pending", "ana", "orders", 1);
    });

    test("every approval method refuses before initialize()", async () => {
      await expect(provider.putApproval(record)).rejects.toThrow("not initialized");
      await expect(provider.getApproval("x")).rejects.toThrow("not initialized");
      await expect(provider.listApprovals({ limit: 1 })).rejects.toThrow("not initialized");
    });
  });

  // docs/CONTEXT.md §4.40: the job queue on SQLite - the claim inside one transaction, one writer at a time.
  describe("jobs", () => {
    const job = {
      id: "j1",
      kind: "ping",
      payload: {},
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 2,
      requestedBy: "root",
      createdAt: "2026-09-14T00:00:00.000Z",
      runAt: "2026-09-14T00:00:00.000Z",
    };
    // The JSON and the columns always agree on the id: putJob writes both from one record.
    const row = (over: Record<string, unknown> = {}) => ({
      id: "j1",
      kind: "ping",
      status: "queued",
      run_at: job.runAt,
      lease_until: null,
      attempts: 0,
      max_attempts: 2,
      worker: null,
      data: JSON.stringify({ ...job, id: (over.id as string | undefined) ?? "j1" }),
      ...over,
    });
    // Every prepared statement, with what its reads answer: the SQL and the arguments are what the tests pin.
    const prepared: { sql: string; run: ReturnType<typeof mock> }[] = [];
    let answers: { get?: () => unknown; all?: () => unknown[]; changes?: number }[] = [];
    beforeEach(() => {
      prepared.length = 0;
      answers = [];
      // The driver mock is typed without parameters; the SQL is what we read off the call.
      mockPrepare.mockImplementation((...args: unknown[]) => {
        const sql = String(args[0]);
        const answer = answers.shift() ?? {};
        const statement = {
          sql,
          get: mock((..._a: unknown[]) => answer.get?.()),
          all: mock((..._a: unknown[]) => answer.all?.() ?? []),
          run: mock((..._a: unknown[]) => ({ changes: answer.changes ?? 1 })),
        };
        prepared.push(statement);
        return statement;
      });
    });
    const last = () => prepared[prepared.length - 1];

    test("putJob, getJob, listJobs and countJobs", async () => {
      await provider.initialize();
      await provider.putJob(job);
      expect(last().sql).toContain("INSERT OR REPLACE INTO jobs");
      expect(last().run.mock.calls[0]).toEqual([
        "j1",
        "ping",
        "queued",
        job.runAt,
        null,
        0,
        2,
        null,
        JSON.stringify(job),
      ]);
      answers = [{ get: () => row({ status: "running", worker: "w:1", lease_until: "L", attempts: 1 }) }];
      expect(await provider.getJob("j1")).toEqual({
        ...job,
        status: "running",
        worker: "w:1",
        leaseUntil: "L",
        attempts: 1,
      });
      expect(await provider.getJob("ghost")).toBeNull();
      answers = [{ all: () => [row()] }];
      const listed = await provider.listJobs({ status: "queued", kind: "ping", limit: 3 });
      expect(listed[0]).toMatchObject({ id: "j1", leaseUntil: undefined, worker: undefined });
      expect(last().sql).toContain("WHERE status = ? AND kind = ? ORDER BY run_at DESC LIMIT ?");
      await provider.listJobs({ limit: 3 });
      expect(last().sql).toContain("FROM jobs ORDER BY run_at DESC LIMIT ?");
      answers = [{ get: () => ({ n: 4 }) }];
      expect(await provider.countJobs("queued")).toBe(4);
    });

    test("claimJob reads the oldest due job and marks it running in one transaction; heartbeat and reclaim", async () => {
      await provider.initialize();
      answers = [{ get: () => row() }];
      const claimed = await provider.claimJob(["ping", "export"], "w:1", "NOW", "LEASE");
      expect(claimed).toMatchObject({ id: "j1", status: "running", attempts: 1, worker: "w:1", leaseUntil: "LEASE" });
      expect(prepared[prepared.length - 2].sql).toContain("kind IN (?, ?)");
      expect(last().sql).toContain("UPDATE jobs SET status = 'running'");
      expect(last().run.mock.calls[0]).toEqual(["LEASE", "w:1", "j1"]);
      expect(await provider.claimJob(["ping"], "w:1", "NOW", "LEASE")).toBeNull();
      expect(await provider.heartbeatJob("j1", "w:1", "L2")).toBe(true);
      expect(last().run.mock.calls[0]).toEqual(["L2", "j1", "w:1"]);
      answers = [{ changes: 0 }];
      expect(await provider.heartbeatJob("j1", "w:2", "L2")).toBe(false);
      answers = [
        {
          all: () => [
            row({ status: "running", attempts: 1, lease_until: "OLD", worker: "dead" }),
            row({ id: "j2", status: "running", attempts: 2, lease_until: "OLD", worker: "dead" }),
          ],
        },
      ];
      const reclaimed = await provider.reclaimJobs("NOW");
      expect(reclaimed.map((j) => [j.id, j.status, j.worker])).toEqual([
        ["j1", "queued", undefined],
        ["j2", "lost", undefined],
      ]);
    });

    // Retention (§4.40): only settled jobs go, and only those due before the instant given.
    test("pruneJobs deletes settled jobs due before the instant and answers the driver's change count", async () => {
      await provider.initialize();
      answers = [{ changes: 3 }];
      expect(await provider.pruneJobs("BEFORE")).toBe(3);
      expect(last().sql).toContain("DELETE FROM jobs WHERE status IN ('done', 'failed', 'lost') AND run_at < ?");
      expect(last().run.mock.calls[0]).toEqual(["BEFORE"]);
    });

    // Leases (§4.41): the same upsert as PostgreSQL's; one writer at a time makes it atomic.
    test("acquireLease is one upsert answered by its change count; listLeases reads every row", async () => {
      await provider.initialize();
      answers = [{ changes: 1 }];
      expect(await provider.acquireLease("alerts-scheduler", "a:1", "NOW", "UNTIL")).toBe(true);
      expect(last().sql).toContain("ON CONFLICT (name) DO UPDATE SET holder = excluded.holder");
      expect(last().sql).toContain("WHERE leases.held_until < ? OR leases.holder = excluded.holder");
      expect(last().run.mock.calls[0]).toEqual(["alerts-scheduler", "a:1", "UNTIL", "NOW"]);
      answers = [{ changes: 0 }];
      expect(await provider.acquireLease("alerts-scheduler", "b:2", "NOW", "UNTIL")).toBe(false);
      answers = [{ all: () => [{ name: "alerts-scheduler", holder: "a:1", held_until: "U" }] }];
      expect(await provider.listLeases()).toEqual([{ name: "alerts-scheduler", holder: "a:1", until: "U" }]);
    });
  });
});
