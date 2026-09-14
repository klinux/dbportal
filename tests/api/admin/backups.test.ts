import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The backup routes (docs/CONTEXT.md §4.14) over a mocked store: the admin gate, the
 * datasource resolved through the same path every route uses, what GET answers for the
 * page, what POST and restore hand the store, and how refusals come back.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root@example.test" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}
const connection = {
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  type: "postgres",
  environment: "development",
};
mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: async (body: { connectionId?: string }) => {
    if (body.connectionId === "seed:orders") return connection;
    if (body.connectionId === "seed:prod")
      return { ...connection, id: "seed:prod", seedId: "prod", environment: "production" };
    throw new SeedConnectionError("not found", 404);
  },
}));
class BackupError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const store = {
  create: mock(async () => ({ name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" })),
  restore: mock(async () => ({ name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" })),
  list: mock(async (_id: string) => [{ name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" }]),
  tool: true,
  bucket: null as string | null,
};
mock.module("@/lib/backups/store", () => ({
  backupSupported: (type: string) => type === "postgres",
  restoreAllowed: (c: { environment?: string }) => c.environment !== "production",
  toolAvailable: async () => store.tool,
  gcsBucket: () => store.bucket,
  listBackups: (id: string) => store.list(id),
  createBackup: (...args: unknown[]) => store.create(...(args as [])),
  restoreBackup: (...args: unknown[]) => store.restore(...(args as [])),
}));
mock.module("@/lib/backups/errors", () => ({ BackupError }));

const { GET, POST } = await import("@/app/api/admin/backups/route");
const { POST: RESTORE } = await import("@/app/api/admin/backups/restore/route");

const url = "http://localhost/api/admin/backups";
const json = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

describe("/api/admin/backups", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    store.tool = true;
    store.bucket = null;
    for (const fn of [store.create, store.restore, store.list]) fn.mockClear();
    store.create.mockImplementation(async () => ({ name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" }));
  });

  test("every handler is admin-only", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(`${url}?datasourceId=orders`))).status).toBe(403);
    expect((await POST(json("/api/admin/backups", { datasourceId: "orders" }))).status).toBe(403);
    expect((await RESTORE(json("/api/admin/backups/restore", { datasourceId: "orders", name: "x" }))).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
  });

  test("GET answers what the page draws: support, the tool, restore on a non-production datasource, the bucket, the files", async () => {
    const res = await GET(new Request(`${url}?datasourceId=orders`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      supported: true,
      tool: true,
      restoreAllowed: true,
      bucket: false,
      backups: [{ name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" }],
    });
    store.bucket = "b";
    store.tool = false;
    const prod = await (await GET(new Request(`${url}?datasourceId=prod`))).json();
    expect(prod).toMatchObject({ restoreAllowed: false, bucket: true, tool: false });
    expect((await GET(new Request(url))).status).toBe(400);
    expect((await GET(new Request(`${url}?datasourceId=ghost`))).status).toBe(404);
  });

  test("an unsupported engine lists nothing and does not ask for the tool", async () => {
    mock.module("@/lib/backups/store", () => ({
      backupSupported: () => false,
      restoreAllowed: () => true,
      toolAvailable: async () => {
        throw new Error("must not be asked");
      },
      gcsBucket: () => null,
      listBackups: () => store.list("orders"),
      createBackup: (...args: unknown[]) => store.create(...(args as [])),
      restoreBackup: (...args: unknown[]) => store.restore(...(args as [])),
    }));
    const { GET: fresh } = await import("@/app/api/admin/backups/route");
    const body = await (await fresh(new Request(`${url}?datasourceId=orders`))).json();
    expect(body).toMatchObject({ supported: false, tool: false, backups: [] });
  });

  test("POST takes a backup as the session's user and answers 201; a missing id or unknown datasource is refused", async () => {
    const res = await POST(json("/api/admin/backups", { datasourceId: "orders" }));
    expect(res.status).toBe(201);
    expect((await res.json()).backup.name).toBe("2026-01-01T00-00-00Z.dump");
    expect((store.create.mock.calls[0] as unknown[])[1]).toBe("root@example.test");
    expect((await POST(json("/api/admin/backups", {}))).status).toBe(400);
    expect((await POST(json("/api/admin/backups", { datasourceId: "ghost" }))).status).toBe(404);
  });

  test("restore hands the name along; the store's refusals keep their status; anything else is a 500", async () => {
    const res = await RESTORE(
      json("/api/admin/backups/restore", { datasourceId: "orders", name: "2026-01-01T00-00-00Z.dump" }),
    );
    expect(res.status).toBe(200);
    expect((store.restore.mock.calls[0] as unknown[])[1]).toBe("2026-01-01T00-00-00Z.dump");
    expect((await RESTORE(json("/api/admin/backups/restore", { datasourceId: "orders" }))).status).toBe(400);
    store.restore.mockImplementationOnce(async () => {
      throw new BackupError("Restore is not offered on a production datasource", 403);
    });
    const refused = await RESTORE(json("/api/admin/backups/restore", { datasourceId: "orders", name: "x.dump" }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("not offered");
    store.create.mockImplementationOnce(async () => {
      throw new Error("disk full at /var/backups");
    });
    expect((await POST(json("/api/admin/backups", { datasourceId: "orders" }))).status).toBe(500);
  });
});
