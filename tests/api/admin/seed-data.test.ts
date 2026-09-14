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
  readSchemaName: (v: unknown) => (v === undefined ? "public" : String(v)),
}));
const startSeedRun = mock((input: { counts: Map<string, number>; truncate: boolean; schema: string }) => ({
  id: "run-1",
  status: "running",
  schema: input.schema,
  truncated: input.truncate,
  tables: [...input.counts.entries()].map(([name, target]) => ({ name, target, inserted: 0 })),
}));
const getSeedRun = mock((id: string) => (id === "run-1" ? { id: "run-1", status: "done", tables: [] } : null));
mock.module("@/lib/seed-data/run", () => ({
  startSeedRun,
  getSeedRun,
  assertSeedable: async (c: { environment: string }) => {
    if (c.environment === "production") {
      const { SeedDataError } = await import("@/lib/seed-data/errors");
      throw new SeedDataError("A production datasource is never seeded", 403);
    }
  },
}));

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
    startSeedRun.mockClear();
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
  });

  test("run reads the catalog again, bounds the counts, starts the job as the session's user and answers 202 with it", async () => {
    const res = await run(json({ datasourceId: "stage", counts: { customers: 5 }, truncate: true }));
    expect(res.status).toBe(202);
    expect((await res.json()).run).toMatchObject({
      id: "run-1",
      truncated: true,
      tables: [{ name: "customers", target: 5 }],
    });
    const input = (startSeedRun.mock.calls[0] as unknown[])[0] as { actor: string; runner: unknown; schema: string };
    expect(input.actor).toBe("root");
    expect(input.runner).toBe(provider);
    expect(input.schema).toBe("public");
    expect((await run(json({ datasourceId: "stage", counts: { customers: -1 } }))).status).toBe(400);
    expect((await run(json({ datasourceId: "prod" }))).status).toBe(403);
  });

  test("status answers the run by id, and 404 for one this process never ran", async () => {
    expect((await (await status(new Request(url), params("run-1"))).json()).run.status).toBe("done");
    expect((await status(new Request(url), params("ghost"))).status).toBe(404);
    getSeedRun.mockImplementationOnce(() => {
      throw new Error("state lost");
    });
    expect((await status(new Request(url), params("run-1"))).status).toBe(500);
  });
});
