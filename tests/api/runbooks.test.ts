import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The runbook routes a session calls (docs/CONTEXT.md §4.20): the list is those on the
 * datasources it may open, never a 403; preparing one binds the values for the
 * datasource's engine, and a runbook on a datasource the session may not open is not
 * found, like the datasource itself. The store's binding is proven in
 * tests/unit/runbooks/store.test.ts; this file proves the HTTP around it.
 */
let session: { role: string; username: string } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));

const orders = {
  id: "customer-orders",
  name: "Orders",
  datasource: "orders",
  sql: "SELECT {{id}}",
  params: [{ name: "id", type: "number" }],
};
const secret = { id: "payroll", name: "Payroll", datasource: "hr", sql: "SELECT 1" };
mock.module("@/lib/seed", () => ({
  getManagedConnections: async () => [{ id: "seed:orders", seedId: "orders", name: "Orders", type: "postgres" }],
}));
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
const { RunbookError, bindRunbook } = await import("@/lib/runbooks/store");
const listRunbooks = mock(async () => [
  { runbook: orders, source: "config" },
  { runbook: secret, source: "store" },
]);
mock.module("@/lib/runbooks/store", () => ({
  RunbookError,
  bindRunbook,
  listRunbooks,
  findRunbook: async (id: string) => [orders, secret].find((r) => r.id === id) ?? null,
}));

const { GET } = await import("@/app/api/runbooks/route");
const { POST } = await import("@/app/api/runbooks/[id]/prepare/route");

const url = "http://localhost/api/runbooks";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const prepare = (id: string, body?: unknown) =>
  POST(
    new Request(`${url}/${id}/prepare`, {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    }),
    params(id),
  );

describe("/api/runbooks", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
  });

  test("both routes need a session", async () => {
    session = null;
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await prepare("customer-orders", { values: { id: 1 } })).status).toBe(401);
  });

  test("GET lists the runbooks on the datasources the session may open; a store that cannot be read is a 500", async () => {
    const body = await (await GET(new Request(url))).json();
    expect(body.runbooks.map((r: { id: string }) => r.id)).toEqual(["customer-orders"]);
    listRunbooks.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });

  test("prepare binds the values for the datasource's engine, and names the runbook and datasource", async () => {
    const res = await prepare("customer-orders", { values: { id: "42" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runbook: "customer-orders",
      datasource: "orders",
      sql: "SELECT $1",
      params: [42],
    });
  });

  test("a missing value is 400 in the runbook's words; an unknown runbook and one on a hidden datasource are 404; a body that is not an object counts as no values", async () => {
    const bad = await prepare("customer-orders", { values: { id: "abc" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('"id" must be a number');
    expect((await prepare("ghost", { values: {} })).status).toBe(404);
    expect((await prepare("payroll", { values: {} })).status).toBe(404);
    expect((await prepare("customer-orders", { values: [1] })).status).toBe(400);
    expect((await prepare("customer-orders")).status).toBe(400);
  });
});
