import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The admin CRUD for shared datasources (docs/CONTEXT.md §4.1 step B). The store is mocked
 * - tests/unit/datasources/store.test.ts owns its behaviour - so what is proven here is the
 * gate, the bodies, the statuses the store's errors turn into, and the audit line each
 * mutation leaves.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root@example.test" };
mock.module("@/lib/auth", () => ({
  getSession: async () => session,
}));

const mockEmitAuditEvent = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));

let configIds = new Set<string>();
// The error mapper (via resolve-connection) imports the seed index too, so the stub has to
// carry the names that module binds, not only the one the routes call.
mock.module("@/lib/seed", () => ({
  getConfigSeedIds: async () => configIds,
  getSeedConnectionById: async () => null,
  getSeedConnectionByIdUnfiltered: async () => null,
  getManagedConnections: async () => [],
  getPendingSeeds: () => [],
  resetCache: () => {},
}));
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({
    version: "1",
    defaults: { environment: "staging" },
    connections: [
      { id: "yaml-one", name: "From YAML", type: "postgres", roles: ["*"], password: "s3cret", group: "core" },
    ],
  }),
}));

class SharedDatasourceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const record = {
  id: "prod-orders",
  name: "Orders",
  type: "postgres",
  roles: ["user"],
  password: "hunter2",
  managed: true,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  createdBy: "root@example.test",
  updatedBy: "root@example.test",
};
let available = true;
let listFails = false;
const store = {
  create: mock(async () => record),
  update: mock(async () => record),
  remove: mock(async () => record),
};
mock.module("@/lib/datasources/store", () => ({
  SharedDatasourceError,
  isSharedStoreAvailable: () => available,
  listSharedDatasources: async () => {
    if (listFails) throw new SharedDatasourceError("no store", 503);
    return [record];
  },
  createSharedDatasource: (...args: unknown[]) => store.create(...(args as [])),
  updateSharedDatasource: (...args: unknown[]) => store.update(...(args as [])),
  deleteSharedDatasource: (...args: unknown[]) => store.remove(...(args as [])),
  toSharedDatasourceView: (r: typeof record) => ({
    ...Object.fromEntries(Object.entries(r).filter(([key]) => key !== "password")),
    hasPassword: !!r.password,
    hasConnectionString: false,
  }),
}));

const { GET, POST } = await import("@/app/api/admin/datasources/route");
const { PUT, DELETE } = await import("@/app/api/admin/datasources/[id]/route");

const url = "http://localhost/api/admin/datasources";
const json = (method: string, body: unknown) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/admin/datasources", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    available = true;
    listFails = false;
    configIds = new Set();
    mockEmitAuditEvent.mockClear();
    store.create.mockClear();
    store.update.mockClear();
    store.remove.mockClear();
    store.create.mockImplementation(async () => record);
    store.update.mockImplementation(async () => record);
    store.remove.mockImplementation(async () => record);
  });

  // The whole point of the feature is that nobody but an admin creates a connection, and a
  // caller probing for the role leaves the same trail the other admin routes leave.
  test("every handler is admin-only, and a non-admin probe is audited as a role denial", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json("POST", record))).status).toBe(403);
    expect((await PUT(json("PUT", record), params("prod-orders"))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("prod-orders"))).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
    const reasons = mockEmitAuditEvent.mock.calls.map((c) => (c as unknown[])[0] as { reason?: string; type: string });
    expect(reasons.length).toBe(4);
    for (const event of reasons) {
      expect(event.type).toBe("permission_denied");
      expect(event.reason).toBe("insufficient_role");
    }
    session = null;
    expect((await GET(new Request(url))).status).toBe(403);
  });

  test("GET lists store records redacted and the YAML datasources as read-only, with the store's availability", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.datasources).toEqual([
      { ...record, password: undefined, hasPassword: true, hasConnectionString: false, source: "store" },
    ]);
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("s3cret");
    // The YAML row says which environment it inherits from the file's defaults.
    expect(body.declared).toEqual([
      {
        id: "yaml-one",
        name: "From YAML",
        type: "postgres",
        environment: "staging",
        group: "core",
        roles: ["*"],
        source: "config",
      },
    ]);
  });

  test("GET passes the store's own failure through with its status", async () => {
    listFails = true;
    const res = await GET(new Request(url));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("no store");
  });

  test("POST creates as the session user, audits it and answers 201 without the secret", async () => {
    const res = await POST(json("POST", { ...record, password: "hunter2" }));
    expect(res.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ id: "prod-orders" }), "root@example.test");
    const body = await res.json();
    expect(body.datasource.hasPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    const event = (mockEmitAuditEvent.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      type: "managed_connection",
      action: "created",
      target: "prod-orders",
      connectionName: "Orders",
      user: "root@example.test",
      result: "success",
    });
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });

  test("POST refuses a body that is not an object, and an id the seed YAML already declares", async () => {
    const bad = await POST(new Request(url, { method: "POST", body: "[]" }));
    expect(bad.status).toBe(400);
    const notJson = await POST(new Request(url, { method: "POST", body: "{" }));
    expect(notJson.status).toBe(400);

    configIds = new Set(["prod-orders"]);
    const taken = await POST(json("POST", record));
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toContain("seed configuration");
    expect(store.create).not.toHaveBeenCalled();
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });

  // The store's own statuses pass through: validation, not found, no server storage.
  test("the store's errors keep their status; anything else is a 500 through the shared mapper", async () => {
    store.create.mockImplementation(async () => {
      throw new SharedDatasourceError("Invalid datasource: id: bad", 400);
    });
    expect((await POST(json("POST", record))).status).toBe(400);
    store.update.mockImplementation(async () => {
      throw new SharedDatasourceError("not found", 404);
    });
    expect((await PUT(json("PUT", record), params("ghost"))).status).toBe(404);
    store.remove.mockImplementation(async () => {
      throw new SharedDatasourceError("no store", 503);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("x"))).status).toBe(503);
    store.create.mockImplementation(async () => {
      throw new Error("disk on fire");
    });
    expect((await POST(json("POST", record))).status).toBe(500);
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });

  test("PUT updates by the path id and audits it", async () => {
    const res = await PUT(json("PUT", { ...record, name: "Orders v2" }), params("prod-orders"));
    expect(res.status).toBe(200);
    expect(store.update).toHaveBeenCalledWith(
      "prod-orders",
      expect.objectContaining({ name: "Orders v2" }),
      "root@example.test",
    );
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    expect(((mockEmitAuditEvent.mock.calls[0] as unknown[])[0] as { action: string }).action).toBe("updated");
    expect((await PUT(new Request(url, { method: "PUT", body: "null" }), params("prod-orders"))).status).toBe(400);
  });

  test("DELETE removes by the path id and audits it", async () => {
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("prod-orders"));
    expect(res.status).toBe(200);
    expect(store.remove).toHaveBeenCalledWith("prod-orders");
    expect(((mockEmitAuditEvent.mock.calls[0] as unknown[])[0] as { action: string }).action).toBe("deleted");
  });
});
