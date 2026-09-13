import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { discoverRoutes } from "../../security/helpers/discover-routes";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { agentReadSqlInput } from "@/lib/db/operations/statement-guard";
import {
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/query/route");

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/query", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  // docs/CONTEXT.md §4.4: the datasource's write rule, enforced before anything reaches the
  // engine. `writeRoles: []` is read-only for everyone, this admin session included.
  test("a read-only datasource runs reads on a read-only pool and refuses writes, explained or not", async () => {
    const readOnly = { ...validConnection, roles: ["*"], writeRoles: [] };
    const post = (body: Record<string, unknown>) =>
      POST(createMockRequest("/api/db/query", { method: "POST", body }) as never);

    expect((await post({ connection: readOnly, sql: "SELECT * FROM users" })).status).toBe(200);
    expect((mockGetOrCreateProvider.mock.calls[0] as unknown[])[1]).toMatchObject({ readOnly: true });

    const denied = await post({ connection: readOnly, sql: "UPDATE users SET name = 'x'" });
    expect(denied.status).toBe(403);
    expect((await parseResponseJSON<{ error: string }>(denied)).error).toContain("read-only");
    const explained = await post({ connection: readOnly, sql: "DELETE FROM users", explain: { mode: "analyze" } });
    expect(explained.status).toBe(403);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
  });

  // docs/CONTEXT.md §4.6: a datasource that requires approval needs the server store the
  // requests live in; without one the write is refused with a 503 that says so, reads run.
  test("an approval-gated datasource without a server store refuses writes with 503 and runs reads", async () => {
    const gated = { ...validConnection, seedId: "orders", roles: ["*"], writeApproval: true };
    const post = (body: Record<string, unknown>) =>
      POST(createMockRequest("/api/db/query", { method: "POST", body }) as never);
    expect((await post({ connection: gated, sql: "SELECT 1" })).status).toBe(200);
    const denied = await post({ connection: gated, sql: "DELETE FROM users" });
    expect(denied.status).toBe(503);
    expect((await parseResponseJSON<{ error: string }>(denied)).error).toContain("server storage");
  });

  // docs/CONTEXT.md §4.7: the rows leave masked by the server's rules (the defaults here -
  // no store is configured), a plan does not, a reveal is granted to the roles the
  // configuration names and audited, and refused with a 403 to the others.
  test("masks sensitive columns before the rows leave, names them, and answers a reveal per role", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [{ id: 1, email: "ana@example.com", note: "n" }],
      fields: ["id", "email", "note"],
      rowCount: 1,
      executionTime: 1,
    }));
    const post = (body: Record<string, unknown>) =>
      POST(createMockRequest("/api/db/query", { method: "POST", body }) as never);
    type Served = { rows: Record<string, unknown>[]; masked: string[] };

    const masked = await parseResponseJSON<Served>(await post({ connection: validConnection, sql: "SELECT 1" }));
    expect(masked.masked).toEqual(["email"]);
    expect(masked.rows[0].email).not.toBe("ana@example.com");
    expect(masked.rows[0].note).toBe("n");

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const revealed = await parseResponseJSON<Served>(
        await post({ connection: validConnection, sql: "SELECT 1", reveal: true }),
      );
      expect(revealed.masked).toEqual([]);
      expect(revealed.rows[0].email).toBe("ana@example.com");
      const line = (logSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
        .map((v) => JSON.parse(v) as Record<string, unknown>)
        .find((e) => e.event === "masking_reveal");
      expect(line).toMatchObject({ actor: "admin", route: "email" });
    } finally {
      logSpy.mockRestore();
    }

    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));
    const denied = await post({ connection: validConnection, sql: "SELECT 1", reveal: true });
    expect(denied.status).toBe(403);
    expect((await parseResponseJSON<{ error: string }>(denied)).error).toContain("reveal");
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  // docs/CONTEXT.md §4.2: every execution leaves a query_execution line naming the person,
  // the datasource and the outcome. Read from stdout, the authoritative channel.
  test("records every execution on the audit channel, success and failure alike", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const ok = await POST(
        createMockRequest("/api/db/query", {
          method: "POST",
          body: { connection: validConnection, sql: "SELECT * FROM users" },
        }) as never,
      );
      expect(ok.status).toBe(200);
      // docs/CONTEXT.md §4.3: the pool is obtained under the person's own label.
      expect(mockGetOrCreateProvider).toHaveBeenLastCalledWith(expect.anything(), {
        applicationName: "admin@dbportal",
      });
      (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(new QueryError("syntax error near 'x'"));
      const failed = await POST(
        createMockRequest("/api/db/query", {
          method: "POST",
          body: { connection: validConnection, sql: "SELEC 1" },
        }) as never,
      );
      expect(failed.status).toBe(400);

      const lines = logSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
        .map((v) => JSON.parse(v) as Record<string, unknown>)
        .filter((l) => l.event === "query_execution");
      expect(lines.map((l) => [l.action, l.outcome, l.reason, l.actor, l.connection, l.route])).toEqual([
        ["query", "success", undefined, "admin", validConnection.name, "POST /api/db/query"],
        ["query", "failure", "query_error", "admin", validConnection.name, "POST /api/db/query"],
      ]);
      // The statement is not recorded unless the operator asked for it.
      expect(lines.every((l) => l.statement === undefined)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("passes queryId to provider when cancellation is supported", async () => {
    const providerWithCancel = {
      ...createMockProvider(),
      cancelQuery: mock(async () => true),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithCancel as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users", queryId: "query-42" },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(providerWithCancel.query).toHaveBeenCalledWith("SELECT * FROM users LIMIT 50", undefined, "query-42");
  });

  // ── Bound parameters (#290) ───────────────────────────────────────────────
  //
  // A generated statement (the inline row editor) sends its values here instead of
  // writing them into the SQL, so a value cannot close a string literal and have
  // the rest read as statement text. The route is the last hop before the driver's
  // bind path, so it is also where an unbindable value is refused.

  test("binds the request's parameters instead of running the statement unbound", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: `UPDATE users SET "name" = $1 WHERE "id" = $2`,
        params: ["\\' WHERE 1=1 -- ", 7],
      },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.query).toHaveBeenCalledWith(`UPDATE users SET "name" = $1 WHERE "id" = $2 LIMIT 50`, [
      "\\' WHERE 1=1 -- ",
      7,
    ]);
  });

  test("binds parameters alongside a queryId when cancellation is supported", async () => {
    const providerWithCancel = {
      ...createMockProvider(),
      cancelQuery: mock(async () => true),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithCancel as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: `UPDATE users SET "name" = $1 WHERE "id" = $2`,
        params: ["Alice", 7],
        queryId: "query-42",
      },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(providerWithCancel.query).toHaveBeenCalledWith(
      `UPDATE users SET "name" = $1 WHERE "id" = $2 LIMIT 50`,
      ["Alice", 7],
      "query-42",
    );
  });

  test("returns 400 for a parameter the driver cannot bind as a scalar", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users WHERE id = $1", params: [{ nested: true }] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("params");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("returns 200 with rows and pagination for valid query", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      rows: unknown[];
      fields: string[];
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
    expect(data.pagination).toBeDefined();
    expect(data.pagination.limit).toBe(50);
    expect(data.pagination.offset).toBe(0);
    expect(data.pagination.wasLimited).toBe(true);
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 400 when sql is missing", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 400 for QueryError", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryError('syntax error at or near "FORM"'),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FORM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("syntax error");
    expect(data.code).toBe("QUERY_ERROR");
  });

  test("returns 408 for TimeoutError", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new TimeoutError("Query timed out after 30000ms"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT pg_sleep(60)" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(408);
    expect(data.error).toContain("timed out");
  });

  test("returns 500 for DatabaseError", async () => {
    const dbError = new DatabaseError("Internal database failure", "postgres", "INTERNAL_ERROR");
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Internal database failure");
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("returns 499 for cancelled query", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryCancelledError("Query was cancelled"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM large_table" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(499);
    expect(data.code).toBe("QUERY_CANCELLED");
    expect(data.error).toContain("cancelled");
  });

  test("returns 500 for generic error", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Something unexpected happened"));

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Something unexpected happened");
  });

  test("calls prepareQuery with sql and options", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "SELECT * FROM users",
        options: { limit: 100 },
      },
    });

    await POST(req as never);

    expect(mockProvider.prepareQuery).toHaveBeenCalledTimes(1);
    expect(mockProvider.prepareQuery).toHaveBeenCalledWith("SELECT * FROM users", { limit: 100 });
  });

  test("pagination hasMore is true when rows.length equals limit", async () => {
    const fiftyRows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: fiftyRows,
      fields: ["id"],
      rowCount: 50,
      executionTime: 10,
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.hasMore).toBe(true);
    expect(data.pagination.totalReturned).toBe(50);
  });

  test("pagination hasMore is false when rows.length less than limit", async () => {
    const threeRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: threeRows,
      fields: ["id"],
      rowCount: 3,
      executionTime: 5,
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.totalReturned).toBe(3);
  });

  test("returns 499 for interrupted query execution", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryCancelledError("Query execution was interrupted"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(499);
    expect(data.code).toBe("QUERY_CANCELLED");
  });
});

/**
 * Regression for #328: the agent enforcement layer must not have followed the
 * operator into the editor. Everything #328 built — the read-only execution
 * profiles, the statement guard, the policy pipeline, the audited execution
 * glue — applies to the AGENT path only; a human running a write in the editor
 * is the product's primary use, and gating it would be a silent regression
 * that no test in the operations layer could see.
 */
describe("POST /api/db/query — the editor path stays outside the agent policy layer", () => {
  const writeStatement = "UPDATE orders SET status = 'shipped' WHERE id = 42";

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("executes a write the agent input contract refuses, through the shared provider", async () => {
    // The same statement, judged by both paths. If these ever agree, one of the
    // two is wrong: the agent contract must refuse it, the editor must run it.
    expect(agentReadSqlInput.safeParse({ sql: writeStatement }).success).toBe(false);

    const writeProvider = createMockProvider({
      prepareQueryResult: { query: writeStatement, wasLimited: false, limit: 0, offset: 0 },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(writeProvider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: writeStatement },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    // Reached the driver verbatim: not refused, not rewritten, not downgraded.
    expect(writeProvider.query).toHaveBeenCalledWith(writeStatement, undefined);
    // The shared, fully-privileged provider cache - never an execution profile.
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
  });

  /**
   * Read from disk rather than asserted through a behaviour, deliberately. The
   * behavioural version of this check would be "the route emits no
   * agent_operation audit event", and it cannot fail: `bun run test` runs this
   * directory in one process with tests/api/db/maintenance.test.ts, whose
   * `mock.module("@/lib/audit")` replaces `emitAuditEvent` itself
   * process-wide, so no destination — buffer or stdout — would see an emission
   * even if the glue WERE wired in. A source-level invariant has no such hole.
   *
   * `discoverRoutes` is reused rather than re-walked here (it lives under
   * tests/security/helpers because the security enumerations were its first
   * callers): it recurses, so it sees `db/schema/list` and `db/schema/relations`
   * alongside `db/schema` — the exact case its own doc comment names, and the
   * one a single-level listing silently drops. Its route keys map back to files
   * deterministically, which is all this assertion needs.
   */
  const DB_ROUTES_DIR = join(import.meta.dir, "..", "..", "..", "src", "app", "api", "db");

  const dbRouteFiles = discoverRoutes(DB_ROUTES_DIR).map(([routeKey]) =>
    join(DB_ROUTES_DIR, ...routeKey.split("/"), "route.ts"),
  );

  test("the route enumeration finds every one of today's sixteen /api/db routes", () => {
    // An enumeration bug that found nothing - or that missed the nested schema
    // routes - would make the next test quietly narrower than it claims.
    expect(dbRouteFiles.length).toBeGreaterThanOrEqual(16);
    expect(dbRouteFiles.every((file) => existsSync(file))).toBe(true);
  });

  test("no /api/db route imports the agent operations layer", () => {
    const gated = dbRouteFiles.filter((file) => readFileSync(file, "utf8").includes("@/lib/db/operations"));
    expect(gated).toEqual([]);
  });
});

// ─── Server-built EXPLAIN (#574) ────────────────────────────────────────────
//
// The Explain panel used to build the EXPLAIN statement in the browser from the
// static `explainFormat` that `POST /api/db/provider-meta` answers WITHOUT
// connecting (#457). On the MySQL wire family the accepted form is only knowable
// once connected: measured 2026-09-06, `EXPLAIN FORMAT=JSON SELECT 1` is errno
// 1105 on TiDB v8.5.1 ("explain format 'json' is not supported now") and Apache
// Doris 4.1.3 ("mismatched input '='"), and errno 1064 on StarRocks 3.3.22 and
// SingleStore, while plain `EXPLAIN SELECT 1` is accepted on all of them. So the
// statement is built here, where the CONNECTED provider is, and the client sends
// the original statement plus the mode it wants.
describe("POST /api/db/query with an explain request", () => {
  const explainCapableProvider = () => createMockProvider({ capabilities: { explainFormat: "postgres-json" } });

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("runs the statement the connected provider's strategy builds and names the format", async () => {
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "SELECT * FROM users",
        options: {},
        explain: { mode: "estimate" },
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ explainFormat: string }>(res);

    expect(res.status).toBe(200);
    expect(provider.query).toHaveBeenCalledWith(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users LIMIT 50",
      undefined,
    );
    expect(data.explainFormat).toBe("postgres-json");
  });

  test("returns 400 and runs nothing when the provider declares no EXPLAIN support", async () => {
    const provider = createMockProvider({ capabilities: { supportsExplain: false, explainFormat: "postgres-json" } });
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("This server does not support EXPLAIN");
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("returns 400 and runs nothing when the provider declares no explain format", async () => {
    // supportsExplain true with no format is the Elasticsearch shape: the button is
    // hidden because no format is declared, so a request for one is still refused.
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("This server does not support EXPLAIN");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("returns 400 and runs nothing when the provider names a format this build does not register", async () => {
    // `getExplainStrategy` indexes a Record, so a format outside the union comes back as
    // undefined rather than null. A strict null check let that fall through to
    // `strategy.buildSql` and a TypeError, which the error mapper reports as a 500 with
    // no sentence a user can act on. Unreachable from this repo's providers today; an
    // external implementer of the published interface can declare anything.
    const provider = createMockProvider({
      capabilities: { supportsExplain: true, explainFormat: "oracle-hierarchy" as never },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("This server does not support EXPLAIN");
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("returns 400 and runs nothing for a statement the strategy declines", async () => {
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "UPDATE users SET name = 'x'",
        explain: { mode: "analyze" },
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("Only SELECT statements can be explained");
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("binds an explain request's parameters to the statement the strategy built", async () => {
    // The strategies only PREFIX the statement, so the built statement carries the
    // same placeholders in the same order and the same values bind them. This is the
    // contract PR #304 relied on when the browser still built the EXPLAIN itself:
    // without it, every generated statement that sends its values separately would
    // lose its plan.
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "SELECT * FROM users WHERE id = $1",
        options: {},
        params: [7],
        explain: { mode: "estimate" },
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ explainFormat: string }>(res);

    expect(res.status).toBe(200);
    expect(provider.query).toHaveBeenCalledWith(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users WHERE id = $1 LIMIT 50",
      [7],
    );
    expect(data.explainFormat).toBe("postgres-json");
  });

  test.each([
    ["a missing mode", {}],
    ["an unknown mode", { mode: "profile" }],
    ["a non-object explain", "estimate"],
    ["a null explain", null],
  ])("returns 400 for %s", async (_label, explain) => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("explain");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("a request without an explain field runs the statement and names no format", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(mockProvider.query).toHaveBeenCalledWith("SELECT * FROM users LIMIT 50", undefined);
    expect("explainFormat" in data).toBe(false);
  });
});
