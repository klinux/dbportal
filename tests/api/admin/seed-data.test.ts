import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The seed routes (docs/CONTEXT.md §4.23) over mocked reading and running: the gates (a
 * session, then the admin role), the plan from a fresh catalog read, the run started from a
 * catalog read of its own with bounded counts, and the status of a run by id.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
const provider = { query: mock(async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 0 })) };
mock.module("@/lib/db", () => ({ getOrCreateProvider: async () => provider }));
class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}
mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: async (body: { connectionId?: string }) => {
    if (body.connectionId === "seed:stage")
      return { id: "seed:stage", seedId: "stage", name: "Stage", type: "postgres", environment: "staging" };
    if (body.connectionId === "seed:prod")
      return { id: "seed:prod", seedId: "prod", name: "Prod", type: "postgres", environment: "production" };
    if (body.connectionId === "seed:mysql")
      return { id: "seed:mysql", seedId: "mysql", name: "My", type: "mysql", environment: "staging", database: "shop" };
    throw new SeedConnectionError("not found", 404);
  },
}));
const tables = [
  {
    name: "customers",
    columns: [
      {
        name: "id",
        dataType: "integer",
        udt: "int4",
        nullable: false,
        hasDefault: true,
        identity: true,
        maxLength: null,
        numericPrecision: null,
        numericScale: null,
        primaryKey: true,
        unique: true,
      },
    ],
  },
];
const readCatalog = mock(async () => tables);
mock.module("@/lib/seed-data/catalog", () => ({
  readCatalog,
  readSchemaName: (v: unknown, engine?: string, database?: string) =>
    v === undefined ? (engine === "mysql" ? String(database) : "public") : String(v),
}));
mock.module("@/lib/seed-data/run", () => ({
  assertSeedable: async (c: { environment: string }) => {
    if (c.environment === "production") {
      const { SeedDataError } = await import("@/lib/seed-data/errors");
      throw new SeedDataError("A production datasource is never seeded", 403);
    }
  },
}));
// The seed is handed to the queue (§4.40); the status is read off the job.
const enqueueSeed = mock(
  async (
    request: { datasourceId: string; schema: string; counts: Map<string, number>; truncate: boolean; mode: string },
    _plan: unknown,
    names: { target: string; source?: string },
    session: { username: string },
  ) => ({
    id: "run-1",
    datasourceId: request.datasourceId,
    datasourceName: names.target,
    ...(names.source ? { sourceName: names.source } : {}),
    schema: request.schema,
    mode: request.mode,
    truncated: request.truncate,
    status: "queued",
    startedBy: session.username,
    startedAt: "x",
    tables: [...request.counts.entries()].map(([name, target]) => ({ name, target, inserted: 0 })),
  }),
);
const seedRunById = mock(async (id: string) => (id === "run-1" ? { id: "run-1", status: "done", tables: [] } : null));
mock.module("@/lib/seed-data/job", () => ({ enqueueSeed, seedRunById }));

const { POST: plan } = await import("@/app/api/admin/seed-data/plan/route");
const { POST: run } = await import("@/app/api/admin/seed-data/run/route");
const { GET: status } = await import("@/app/api/admin/seed-data/[id]/route");

const url = "http://localhost/api/admin/seed-data";
const json = (body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/admin/seed-data", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "admin", username: "root" };
    readCatalog.mockClear();
    enqueueSeed.mockClear();
  });

  test("a session first, then the admin role, on every handler", async () => {
    session = null;
    expect((await plan(json({ datasourceId: "stage" }))).status).toBe(401);
    expect((await run(json({ datasourceId: "stage" }))).status).toBe(401);
    expect((await status(new Request(url), params("run-1"))).status).toBe(403);
    session = { role: "user", username: "bob" };
    expect((await plan(json({ datasourceId: "stage" }))).status).toBe(403);
    expect((await run(json({ datasourceId: "stage" }))).status).toBe(403);
    expect((await status(new Request(url), params("run-1"))).status).toBe(403);
    expect(readCatalog).not.toHaveBeenCalled();
  });

  test("plan reads the catalog for the datasource and schema and answers the ordered tables with default counts", async () => {
    const res = await plan(json({ datasourceId: "stage", schema: "sales" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schema: "sales",
      tables: [{ name: "customers", columns: 1, dependsOn: [], rows: 100 }],
    });
    expect((readCatalog.mock.calls[0] as unknown[])[1]).toBe("sales");
    expect((await plan(json({}))).status).toBe(400);
    expect((await plan(json({ datasourceId: "prod" }))).status).toBe(403);
    expect((await plan(json({ datasourceId: "ghost" }))).status).toBe(404);
    // docs/CONTEXT.md §4.23 on MySQL: the schema is the datasource's own database unless named.
    const mysql = await plan(json({ datasourceId: "mysql" }));
    expect(mysql.status).toBe(200);
    expect((await mysql.json()).schema).toBe("shop");
    expect((readCatalog.mock.calls.at(-1) as unknown[]).slice(1)).toEqual(["shop", "mysql"]);
  });

  test("run reads the catalog again, bounds the counts, hands the seed to the queue as the session and answers 202 with the queued run", async () => {
    const res = await run(json({ datasourceId: "stage", counts: { customers: 5 }, truncate: true }));
    expect(res.status).toBe(202);
    expect((await res.json()).run).toMatchObject({
      id: "run-1",
      status: "queued",
      truncated: true,
      startedBy: "root",
      tables: [{ name: "customers", target: 5 }],
    });
    const [request, plan, names, session] = enqueueSeed.mock.calls[0] as unknown[] as [
      { schema: string; mode: string; counts: Map<string, number> },
      unknown[],
      { target: string; source?: string },
      { username: string },
    ];
    expect(request.schema).toBe("public");
    expect(request.mode).toBe("generate");
    expect(request.counts).toEqual(new Map([["customers", 5]]));
    expect(plan).toHaveLength(1);
    expect(names).toEqual({ target: "Stage", source: undefined });
    expect(session.username).toBe("root");
    expect((await run(json({ datasourceId: "stage", counts: { customers: -1 } }))).status).toBe(400);
    expect((await run(json({ datasourceId: "prod" }))).status).toBe(403);
  });

  test("status answers the run read off its job, and 404 for an id the queue does not know", async () => {
    expect((await (await status(new Request(url), params("run-1"))).json()).run.status).toBe("done");
    expect((await status(new Request(url), params("ghost"))).status).toBe(404);
    seedRunById.mockImplementationOnce(async () => {
      throw new Error("state lost");
    });
    expect((await status(new Request(url), params("run-1"))).status).toBe(500);
  });

  // docs/CONTEXT.md §4.31: the copy mode names a source this session may open, PostgreSQL, not the target itself.
  test("run in copy mode opens the source read-only and hands it on; refuses no source, the target itself, another engine, and a bad ratio", async () => {
    const res = await run(json({ datasourceId: "stage", mode: "copy", sourceDatasourceId: "prod", ratios: {} }));
    expect(res.status).toBe(202);
    const [request, , names] = enqueueSeed.mock.calls[0] as unknown[] as [
      { mode: string; sourceDatasourceId?: string; ratios: Map<string, number> },
      unknown,
      { target: string; source?: string },
    ];
    expect(request.mode).toBe("copy");
    expect(request.sourceDatasourceId).toBe("prod");
    expect(names.source).toBe("Prod");
    expect(request.ratios).toEqual(new Map());
    expect((await run(json({ datasourceId: "stage", mode: "copy" }))).status).toBe(400);
    expect((await run(json({ datasourceId: "stage", mode: "copy", sourceDatasourceId: "stage" }))).status).toBe(400);
    const other = await run(json({ datasourceId: "stage", mode: "copy", sourceDatasourceId: "mysql" }));
    expect(other.status).toBe(403);
    expect((await other.json()).error).toContain("same engine");
    expect((await run(json({ datasourceId: "stage", mode: "copy", sourceDatasourceId: "ghost" }))).status).toBe(404);
    expect((await run(json({ datasourceId: "stage", ratios: { customers: 2 } }))).status).toBe(400);
  });
});
