import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The admin routes for runbooks (docs/CONTEXT.md §4.20) over a mocked store: the gate, the
 * listing with each runbook's source, the create with its audit line, the delete, and how
 * the store's refusals come back.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root@example.test" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const mockEmitAuditEvent = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));

class RunbookError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const runbook = { id: "customer-orders", name: "Orders", datasource: "orders", sql: "SELECT 1" };
const record = { ...runbook, createdAt: "x", createdBy: "root@example.test" };
const store = {
  create: mock(async () => record),
  remove: mock(async () => record),
  list: mock(async () => [{ runbook, source: "config" }]),
};
mock.module("@/lib/runbooks/store", () => ({
  RunbookError,
  listRunbooks: () => store.list(),
  createRunbook: (...args: unknown[]) => store.create(...(args as [])),
  deleteRunbook: (...args: unknown[]) => store.remove(...(args as [])),
}));

const { GET, POST } = await import("@/app/api/admin/runbooks/route");
const { DELETE } = await import("@/app/api/admin/runbooks/[id]/route");

const url = "http://localhost/api/admin/runbooks";
const json = (method: string, body: unknown) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const audited = () => mockEmitAuditEvent.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("/api/admin/runbooks", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    mockEmitAuditEvent.mockClear();
    for (const fn of [store.create, store.remove, store.list]) fn.mockClear();
    store.create.mockImplementation(async () => record);
    store.remove.mockImplementation(async () => record);
  });

  test("every handler is admin-only", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json("POST", runbook))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("customer-orders"))).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
  });

  test("GET lists every runbook with its source", async () => {
    const body = await (await GET(new Request(url))).json();
    expect(body.runbooks).toEqual([{ ...runbook, source: "config" }]);
  });

  test("POST declares a runbook as the session's user, answers 201 with source store, and audits it; refusals keep their status", async () => {
    const res = await POST(json("POST", runbook));
    expect(res.status).toBe(201);
    expect((await res.json()).runbook).toMatchObject({ id: "customer-orders", source: "store" });
    expect((store.create.mock.calls[0] as unknown[])[1]).toBe("root@example.test");
    expect(audited()[0]).toMatchObject({ type: "runbook", action: "created", target: "customer-orders" });
    const bad = new Request(url, { method: "POST", body: "[]", headers: { "Content-Type": "application/json" } });
    expect((await POST(bad)).status).toBe(400);
    store.create.mockImplementationOnce(async () => {
      throw new RunbookError("exists", 409);
    });
    expect((await POST(json("POST", runbook))).status).toBe(409);
    expect(audited()).toHaveLength(1);
  });

  test("DELETE removes the runbook the path names and audits it; the store's refusals keep their status; anything else is 500", async () => {
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("customer-orders"));
    expect(await res.json()).toEqual({ deleted: "customer-orders" });
    expect(audited()[0]).toMatchObject({ type: "runbook", action: "deleted" });
    store.remove.mockImplementationOnce(async () => {
      throw new RunbookError('Runbook "x" not found', 404);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("x"))).status).toBe(404);
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
