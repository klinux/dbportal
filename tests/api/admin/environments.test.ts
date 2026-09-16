import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The environment routes (docs/CONTEXT.md §4.36) over a mocked store: the session route
 * lists them for anyone signed in; the admin routes list with sources, save with an audit
 * line, and delete refusing what the store refuses.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
class EnvironmentError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const qa = { id: "qa", label: "QA", color: "#abcdef", order: 2 };
const store = {
  list: mock(async () => [{ environment: qa, source: "store" }]),
  save: mock(async () => ({ ...qa, createdAt: "x", createdBy: "root" })),
  remove: mock(async (_id: string, _inUse: unknown) => ({ ...qa, createdAt: "x", createdBy: "root" })),
};
mock.module("@/lib/environments/store", () => ({
  EnvironmentError,
  listEnvironments: () => store.list(),
  saveEnvironment: (...a: unknown[]) => store.save(...(a as [])),
  deleteEnvironment: (...a: unknown[]) => store.remove(...(a as [string, unknown])),
}));
class SharedDatasourceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
mock.module("@/lib/datasources/store", () => ({
  // The draft test's loan of a stored secret (§4.48) is not this file's subject: a draft passes through.
  withStoredSecret: async (draft: unknown) => draft,
  SharedDatasourceError,
  listSharedDatasources: async () => [{ id: "d", environment: "qa" }],
}));

const { GET: list } = await import("@/app/api/environments/route");
const { GET, POST } = await import("@/app/api/admin/environments/route");
const { DELETE } = await import("@/app/api/admin/environments/[id]/route");

const url = "http://localhost/api/admin/environments";
const json = (body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("environments routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "admin", username: "root" };
    audit.mockClear();
    store.remove.mockClear();
  });

  test("anyone signed in reads the list; the admin routes are admin-only", async () => {
    session = { role: "user", username: "bob" };
    expect(await (await list(new Request("http://localhost/api/environments"))).json()).toEqual({ environments: [qa] });
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json(qa))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("qa"))).status).toBe(403);
    session = null;
    expect((await list(new Request("http://localhost/api/environments"))).status).toBe(401);
  });

  test("the admin list carries the source; a save answers 201 and audits; a bad body is 400", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({ environments: [{ ...qa, source: "store" }] });
    const res = await POST(json(qa));
    expect(res.status).toBe(201);
    expect((await res.json()).environment).toMatchObject({ id: "qa", source: "store" });
    expect((audit.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "environment", action: "saved", target: "qa" });
    expect(
      (await POST(new Request(url, { method: "POST", body: "[]", headers: { "Content-Type": "application/json" } })))
        .status,
    ).toBe(400);
    store.save.mockImplementationOnce(async () => {
      throw new EnvironmentError("Invalid environment: color", 400);
    });
    expect((await POST(json({ ...qa, color: "red" }))).status).toBe(400);
    // The session route's own failure path.
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await list(new Request("http://localhost/api/environments"))).status).toBe(500);
  });

  test("a delete asks the store with whether a datasource uses the id, audits, and keeps the store's refusal", async () => {
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("qa"));
    expect(await res.json()).toEqual({ deleted: "qa" });
    const inUse = (store.remove.mock.calls[0] as unknown[])[1] as (id: string) => Promise<boolean>;
    expect(await inUse("qa")).toBe(true);
    expect(await inUse("other")).toBe(false);
    expect((audit.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "environment", action: "deleted" });
    store.remove.mockImplementationOnce(async () => {
      throw new EnvironmentError("stays", 409);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("production"))).status).toBe(409);
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
