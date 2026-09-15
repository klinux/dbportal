import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { JobRecord } from "@/lib/storage/types";

/**
 * The backup routes (docs/CONTEXT.md §4.14, §4.40) over a mocked store and queue: the admin
 * gate, the datasource resolved through the same path every route uses, what GET answers
 * for the page (the open job included), the job POST and restore hand the queue and how
 * its outcome comes back - the file, 202 past the wait, the failure's word - and the
 * status route that reads a job back.
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
const store = {
  list: mock(async (_id: string) => [{ name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" }]),
  tool: true,
  bucket: null as string | null,
};
// Copied before any mock: bun rewires the module's bindings, so a later spread would carry a stub along.
const realStore = { ...(await import("@/lib/backups/store")) };
mock.module("@/lib/backups/store", () => ({
  ...realStore,
  toolAvailable: async () => store.tool,
  gcsBucket: () => store.bucket,
  listBackups: (id: string) => store.list(id),
}));
const file = { name: "2026-01-01T00-00-00Z.dump", size: 5, createdAt: "x" };
const jobs = new Map<string, JobRecord>();
let settle: Partial<JobRecord> | null = { status: "done", result: file };
const realQueue = await import("@/lib/jobs/queue");
mock.module("@/lib/jobs/queue", () => ({
  ...realQueue,
  enqueueJob: async (input: { kind: string; payload: Record<string, unknown>; requestedBy: string }) => {
    if (input.payload.datasourceId === "boom") throw new Error("disk full at /var/backups");
    const job = { id: `job-${jobs.size + 1}`, status: "queued", attempts: 0, ...input } as JobRecord;
    jobs.set(job.id, job);
    return job;
  },
  listJobs: async (q: { status: string }) => [...jobs.values()].filter((j) => j.status === q.status),
  getJob: async (id: string) => {
    if (id === "broken") throw new Error("store down");
    return jobs.get(id) ?? null;
  },
  waitForJob: async (id: string) => {
    const job = jobs.get(id);
    if (!job || !settle) return job ?? null;
    Object.assign(job, settle);
    return job;
  },
}));

const { GET, POST } = await import("@/app/api/admin/backups/route");
const { POST: RESTORE } = await import("@/app/api/admin/backups/restore/route");
const { GET: STATUS } = await import("@/app/api/admin/backups/[jobId]/route");

const url = "http://localhost/api/admin/backups";
const json = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
const status = (id: string) => STATUS(new Request(`${url}/${id}`), { params: Promise.resolve({ jobId: id }) });

describe("/api/admin/backups", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    store.tool = true;
    store.bucket = null;
    store.list.mockClear();
    jobs.clear();
    settle = { status: "done", result: file };
  });

  test("every handler is admin-only", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(`${url}?datasourceId=orders`))).status).toBe(403);
    expect((await POST(json("/api/admin/backups", { datasourceId: "orders" }))).status).toBe(403);
    expect((await RESTORE(json("/api/admin/backups/restore", { datasourceId: "orders", name: "x" }))).status).toBe(403);
    expect((await status("job-1")).status).toBe(403);
    expect(jobs.size).toBe(0);
  });

  test("GET answers what the page draws: support, the tool, restore on a non-production datasource, the bucket, the files, the open job", async () => {
    const res = await GET(new Request(`${url}?datasourceId=orders`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      supported: true,
      tool: true,
      restoreAllowed: true,
      bucket: false,
      backups: [file],
      job: null,
    });
    settle = null;
    await POST(json("/api/admin/backups", { datasourceId: "orders" }));
    expect((await (await GET(new Request(`${url}?datasourceId=orders`))).json()).job).toEqual({
      jobId: "job-1",
      action: "create",
      status: "queued",
    });
    store.bucket = "b";
    store.tool = false;
    const prod = await (await GET(new Request(`${url}?datasourceId=prod`))).json();
    expect(prod).toMatchObject({ restoreAllowed: false, bucket: true, tool: false, job: null });
    expect((await GET(new Request(url))).status).toBe(400);
    expect((await GET(new Request(`${url}?datasourceId=ghost`))).status).toBe(404);
  });

  test("an unsupported engine lists nothing and does not ask for the tool or the queue", async () => {
    mock.module("@/lib/backups/store", () => ({
      ...realStore,
      backupSupported: () => false,
      toolAvailable: async () => {
        throw new Error("must not be asked");
      },
      gcsBucket: () => null,
      listBackups: () => store.list("orders"),
    }));
    const { GET: fresh } = await import("@/app/api/admin/backups/route");
    const body = await (await fresh(new Request(`${url}?datasourceId=orders`))).json();
    expect(body).toMatchObject({ supported: false, tool: false, backups: [], job: null });
    mock.module("@/lib/backups/store", () => ({
      ...realStore,
      toolAvailable: async () => store.tool,
      gcsBucket: () => store.bucket,
      listBackups: (id: string) => store.list(id),
    }));
  });

  test("POST queues a backup as the session's user and answers 201 with the file once the worker wrote it; a missing id or unknown datasource is refused", async () => {
    const res = await POST(json("/api/admin/backups", { datasourceId: "orders" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ jobId: "job-1", action: "create", status: "done", backup: file });
    expect(jobs.get("job-1")).toMatchObject({ kind: "backup", requestedBy: "root@example.test" });
    expect((await POST(json("/api/admin/backups", {}))).status).toBe(400);
    expect((await POST(json("/api/admin/backups", { datasourceId: "ghost" }))).status).toBe(404);
    store.tool = false;
    const noTool = await POST(json("/api/admin/backups", { datasourceId: "orders" }));
    expect(noTool.status).toBe(503);
    expect((await noTool.json()).error).toContain("pg_dump");
  });

  test("past the wait POST answers 202 with the job; a second request while it is open is a 409; the status route follows it", async () => {
    settle = null;
    const queued = await POST(json("/api/admin/backups", { datasourceId: "orders" }));
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ jobId: "job-1", action: "create", status: "queued" });
    const again = await POST(json("/api/admin/backups", { datasourceId: "orders" }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain("already queued");
    expect((await status("job-1")).status).toBe(202);
    Object.assign(jobs.get("job-1")!, { status: "done", result: file });
    const done = await status("job-1");
    expect(done.status).toBe(200);
    expect((await done.json()).backup).toEqual(file);
    Object.assign(jobs.get("job-1")!, { status: "failed", error: "BackupError" });
    const failed = await status("job-1");
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toContain("backup failed (BackupError)");
    Object.assign(jobs.get("job-1")!, { status: "lost" });
    expect((await status("job-1")).status).toBe(500);
    expect((await status("ghost")).status).toBe(404);
    jobs.set("job-9", { id: "job-9", kind: "ping", status: "done", payload: {} } as JobRecord);
    expect((await status("job-9")).status).toBe(404);
    const broken = await status("broken");
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  test("restore queues the file's name and answers 200 when done; refusals keep their status; anything else is a 500", async () => {
    const res = await RESTORE(
      json("/api/admin/backups/restore", { datasourceId: "orders", name: "2026-01-01T00-00-00Z.dump" }),
    );
    expect(res.status).toBe(200);
    expect(jobs.get("job-1")?.payload).toMatchObject({ action: "restore", name: "2026-01-01T00-00-00Z.dump" });
    expect((await RESTORE(json("/api/admin/backups/restore", { datasourceId: "orders" }))).status).toBe(400);
    const refused = await RESTORE(
      json("/api/admin/backups/restore", { datasourceId: "prod", name: "2026-01-01T00-00-00Z.dump" }),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("not offered");
    expect(
      (await RESTORE(json("/api/admin/backups/restore", { datasourceId: "orders", name: "2026-03-03T00-00-00Z.dump" })))
        .status,
    ).toBe(404);
    settle = null;
    jobs.clear();
    const queued = await RESTORE(
      json("/api/admin/backups/restore", { datasourceId: "orders", name: "2026-01-01T00-00-00Z.dump" }),
    );
    expect(queued.status).toBe(202);
    expect((await queued.json()).action).toBe("restore");
    connection.seedId = "boom";
    expect((await POST(json("/api/admin/backups", { datasourceId: "orders" }))).status).toBe(500);
    connection.seedId = "orders";
  });
});
