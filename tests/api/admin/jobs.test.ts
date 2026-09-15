import { describe, test, expect, beforeEach, mock } from "bun:test";

/** The queue's admin routes (docs/CONTEXT.md §4.40): counts and the latest jobs, filtered; a ping enqueued; admin only; the queue's refusals answered. */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
const real = await import("@/lib/jobs/queue");
const ping = { id: "j1", kind: "ping", status: "queued", payload: { echo: "hi" }, requestedBy: "root" };
const queue = {
  list: mock(async (_q: unknown) => [ping]),
  count: mock(async (status: string) => (status === "queued" ? 1 : 0)),
  enqueue: mock(async (_i: unknown) => ping),
};
mock.module("@/lib/jobs/queue", () => ({
  ...real,
  listJobs: (q: unknown) => queue.list(q),
  countJobs: (s: string) => queue.count(s),
  enqueueJob: (i: unknown) => queue.enqueue(i),
}));
const { GET } = await import("@/app/api/admin/jobs/route");
const { POST } = await import("@/app/api/admin/jobs/ping/route");
const url = "http://localhost/api/admin/jobs";

describe("/api/admin/jobs", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root" };
    queue.list.mockClear();
    queue.enqueue.mockClear();
  });

  test("lists counts and jobs with the filters read, enqueues a ping, admin only, and answers the queue's refusals", async () => {
    expect(await (await GET(new Request(`${url}?status=queued&kind=ping&limit=5`))).json()).toEqual({
      counts: { queued: 1, running: 0, done: 0, failed: 0, lost: 0 },
      jobs: [ping],
    });
    expect(queue.list.mock.calls[0][0]).toEqual({ status: "queued", kind: "ping", limit: 5 });
    await GET(new Request(`${url}?status=nope&limit=abc`));
    expect(queue.list.mock.calls[1][0]).toEqual({ limit: 50 });
    const posted = await POST(
      new Request(`${url}/ping`, {
        method: "POST",
        body: JSON.stringify({ echo: "hi" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(posted.status).toBe(202);
    expect(queue.enqueue.mock.calls[0][0]).toEqual({ kind: "ping", payload: { echo: "hi" }, requestedBy: "root" });
    await POST(new Request(`${url}/ping`, { method: "POST" }));
    expect(queue.enqueue.mock.calls[1][0]).toEqual({ kind: "ping", payload: {}, requestedBy: "root" });
    queue.enqueue.mockImplementationOnce(async () => {
      throw new real.JobError("no store", 503);
    });
    expect((await POST(new Request(`${url}/ping`, { method: "POST" }))).status).toBe(503);
    queue.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
    session = { role: "user", username: "ana" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(new Request(`${url}/ping`, { method: "POST" }))).status).toBe(403);
  });
});
