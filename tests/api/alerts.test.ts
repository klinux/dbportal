import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The alert routes (docs/CONTEXT.md §4.29): the session's list, a definition admitted only
 * when the datasource opens for this session, the statement reads and every channel is
 * declared; replaced or deleted by its owner or an administrator, someone else's not found;
 * and a run on demand that answers the state it landed in.
 */
let session: { role: string; username: string } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
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
    if (body.connectionId === "seed:orders")
      return { id: "seed:orders", seedId: "orders", name: "Orders", type: "postgres" };
    throw new SeedConnectionError(`Seed connection "${body.connectionId}" not found`, 404);
  },
}));
const realChannels = await import("@/lib/channels/store");
mock.module("@/lib/channels/store", () => ({
  ...realChannels,
  findChannel: async (id: string) => (id === "ops" ? { id } : null),
}));
const real = await import("@/lib/alerts/store");
const base = {
  id: "slow-orders",
  name: "Slow orders",
  datasource: "orders",
  sql: "SELECT count(*) AS count FROM orders",
  op: ">",
  value: 100,
  everyMinutes: 5,
  cooldownMinutes: 60,
  channels: ["ops"],
  enabled: true,
};
const anas = {
  ...base,
  owner: { username: "ana", role: "user" },
  createdAt: "x",
  updatedAt: "x",
  state: { status: "ok" },
};
const bobs = { ...anas, id: "bobs", owner: { username: "bob", role: "user" } };
const store = {
  list: mock(async (_s: unknown) => [anas]),
  save: mock(async (data: unknown, s: { username: string }) => ({
    ...(data as object),
    owner: { username: s.username, role: "user" },
    state: { status: "unknown" },
  })),
  find: mock(async (id: string) => (id === "slow-orders" ? anas : id === "bobs" ? bobs : null)),
  remove: mock(async (_id: unknown, _s: unknown) => anas),
};
mock.module("@/lib/alerts/store", () => ({
  ...real,
  listAlerts: (s: unknown) => store.list(s as never),
  saveAlert: (d: unknown, s: unknown) => store.save(d, s as { username: string }),
  findAlert: (id: string) => store.find(id),
  deleteAlert: (id: string, s: unknown) => store.remove(id as never, s as never),
}));
const run = mock(async (_a: unknown) => ({ status: "firing", lastValue: "120" }));
mock.module("@/lib/alerts/run", () => ({ runAlert: run }));

const { GET, POST } = await import("@/app/api/alerts/route");
const { PUT, DELETE } = await import("@/app/api/alerts/[id]/route");
const { POST: RUN } = await import("@/app/api/alerts/[id]/run/route");

const url = "http://localhost/api/alerts";
const json = (body: unknown, method = "POST") =>
  new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("alert routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
    audit.mockClear();
    run.mockClear();
  });

  test("a session is required everywhere", async () => {
    session = null;
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await POST(json(base))).status).toBe(401);
    expect((await PUT(json(base, "PUT"), params("slow-orders"))).status).toBe(401);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("slow-orders"))).status).toBe(401);
    expect((await RUN(new Request(url, { method: "POST" }), params("slow-orders"))).status).toBe(401);
  });

  test("lists, and admits a definition only when the datasource opens, the statement reads and the channels exist", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({ alerts: [anas] });
    const created = await POST(json(base));
    expect(created.status).toBe(201);
    expect((await created.json()).alert).toMatchObject({ id: "slow-orders", owner: { username: "ana" } });
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "alert",
      action: "saved",
      target: "slow-orders",
      details: "orders; every 5 min",
    });
    expect((await POST(new Request(url, { method: "POST", body: "1" }))).status).toBe(400);
    expect((await POST(json({ ...base, everyMinutes: 0 }))).status).toBe(400);
    expect((await POST(json({ ...base, datasource: "payroll" }))).status).toBe(404);
    const writes = await POST(json({ ...base, sql: "DELETE FROM orders" }));
    expect(writes.status).toBe(400);
    expect((await writes.json()).error).toContain("reads");
    const unknown = await POST(json({ ...base, channels: ["ghost"] }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain('"ghost"');
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });

  test("replaces and deletes an owner's own; someone else's is not found; an administrator reaches every one", async () => {
    const replaced = await PUT(json({ ...base, id: "ignored", name: "Slower" }, "PUT"), params("slow-orders"));
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).alert).toMatchObject({ id: "slow-orders", name: "Slower" });
    expect((await PUT(new Request(url, { method: "PUT", body: "[]" }), params("slow-orders"))).status).toBe(400);
    expect((await PUT(json(base, "PUT"), params("bobs"))).status).toBe(404);
    expect((await PUT(json(base, "PUT"), params("ghost"))).status).toBe(404);
    expect(await (await DELETE(new Request(url, { method: "DELETE" }), params("slow-orders"))).json()).toEqual({
      deleted: "slow-orders",
    });
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({ type: "alert", action: "deleted" });
    store.remove.mockImplementationOnce(async () => {
      throw new real.AlertError("someone else's", 403);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("bobs"))).status).toBe(403);
    session = { role: "admin", username: "root" };
    expect((await PUT(json(base, "PUT"), params("bobs"))).status).toBe(200);
  });

  test("runs one now and answers the state; someone else's is not found", async () => {
    expect(await (await RUN(new Request(url, { method: "POST" }), params("slow-orders"))).json()).toEqual({
      state: { status: "firing", lastValue: "120" },
    });
    expect(run.mock.calls[0][0]).toEqual(anas);
    expect((await RUN(new Request(url, { method: "POST" }), params("bobs"))).status).toBe(404);
    run.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect((await RUN(new Request(url, { method: "POST" }), params("slow-orders"))).status).toBe(500);
  });
});
