import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The admin routes for freeze windows (docs/CONTEXT.md §4.17) over a mocked store: the
 * gate, the listing with each window's source, the create with its audit line, the delete
 * that ends a window, and how the store's refusals come back.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root@example.test" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const mockEmitAuditEvent = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));

class FreezeError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const window = {
  id: "release-42",
  reason: "Release 42 deploy",
  from: "2026-09-14T09:00:00.000Z",
  until: "2026-09-14T12:00:00.000Z",
};
const store = {
  create: mock(async () => ({ ...window, createdAt: "x", createdBy: "root@example.test" })),
  remove: mock(async () => ({ ...window, createdAt: "x", createdBy: "root@example.test" })),
  list: mock(async () => [{ window, source: "config" }]),
};
mock.module("@/lib/freezes/store", () => ({
  FreezeError,
  listFreezeWindows: () => store.list(),
  createFreezeWindow: (...args: unknown[]) => store.create(...(args as [])),
  deleteFreezeWindow: (...args: unknown[]) => store.remove(...(args as [])),
  activeFreeze: async () => null,
  covers: () => false,
}));

const { GET, POST } = await import("@/app/api/admin/freezes/route");
const { DELETE } = await import("@/app/api/admin/freezes/[id]/route");

const url = "http://localhost/api/admin/freezes";
const json = (method: string, body: unknown) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const audited = () => mockEmitAuditEvent.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("/api/admin/freezes", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    mockEmitAuditEvent.mockClear();
    for (const fn of [store.create, store.remove, store.list]) fn.mockClear();
    store.create.mockImplementation(async () => ({ ...window, createdAt: "x", createdBy: "root@example.test" }));
    store.remove.mockImplementation(async () => ({ ...window, createdAt: "x", createdBy: "root@example.test" }));
  });

  test("every handler is admin-only", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json("POST", window))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("release-42"))).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
  });

  test("GET lists every window with its source", async () => {
    const body = await (await GET(new Request(url))).json();
    expect(body.windows).toEqual([{ ...window, source: "config" }]);
  });

  test("POST declares a window as the session's user, answers 201 with source store, and audits it", async () => {
    const res = await POST(json("POST", window));
    expect(res.status).toBe(201);
    expect((await res.json()).window).toMatchObject({ id: "release-42", source: "store" });
    expect((store.create.mock.calls[0] as unknown[])[1]).toBe("root@example.test");
    expect(audited()[0]).toMatchObject({ type: "freeze_window", action: "created", target: "release-42" });
    const bad = new Request(url, { method: "POST", body: "[]", headers: { "Content-Type": "application/json" } });
    expect((await POST(bad)).status).toBe(400);
  });

  test("DELETE ends the window the path names and audits it; the store's refusals keep their status; anything else is 500", async () => {
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("release-42"));
    expect(await res.json()).toEqual({ deleted: "release-42" });
    expect(audited()[0]).toMatchObject({ type: "freeze_window", action: "deleted" });
    store.remove.mockImplementationOnce(async () => {
      throw new FreezeError('Freeze window "x" not found', 404);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("x"))).status).toBe(404);
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
