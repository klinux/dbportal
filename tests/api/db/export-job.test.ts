import { describe, test, expect, mock, beforeEach } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/** The download of an export that outran the wait (docs/CONTEXT.md §4.40): its requester's, or an administrator's; 202 while it is built. */
let session: { role: string; username: string } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
const jobs: Record<string, Record<string, unknown>> = {
  "job-1": { id: "job-1", kind: "export", status: "done", requestedBy: "ana" },
  "job-2": { id: "job-2", kind: "export", status: "running", requestedBy: "ana" },
  "job-3": { id: "job-3", kind: "export", status: "done", requestedBy: "bob" },
  "job-4": { id: "job-4", kind: "ping", status: "done", requestedBy: "ana" },
};
const realQueue = await import("@/lib/jobs/queue");
mock.module("@/lib/jobs/queue", () => ({
  ...realQueue,
  getJob: async (id: string) => {
    if (id === "broken") throw new Error("store down");
    return jobs[id] ?? null;
  },
}));
const realRequest = await import("@/lib/export/request");
mock.module("@/lib/export/request", () => ({
  ...realRequest,
  exportFileOf: async (job: { id: string }) =>
    job.id === "job-1" || job.id === "job-3"
      ? {
          result: { file: "/x", extension: "json", mimeType: "application/json", rows: 1, bytes: 3 },
          content: Buffer.from("[1]"),
        }
      : null,
}));
const { GET } = await import("@/app/api/db/export/[jobId]/route");
const get = (id: string) =>
  GET(new Request("http://localhost/api/db/export/x"), { params: Promise.resolve({ jobId: id }) });

describe("GET /api/db/export/[jobId]", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
  });

  test("streams one's own finished export, answers 202 while it is built, and 404 for another's, another kind, or nothing", async () => {
    const res = await get("job-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe("[1]");
    const building = await get("job-2");
    expect(building.status).toBe(202);
    expect(await building.json()).toEqual({ jobId: "job-2", status: "running" });
    expect((await get("job-3")).status).toBe(404);
    expect((await get("job-4")).status).toBe(404);
    expect((await get("ghost")).status).toBe(404);
    session = { role: "admin", username: "root" };
    expect((await get("job-3")).status).toBe(200);
    session = null;
    expect((await get("job-1")).status).toBe(401);
  });

  test("a store that fails to answer is a 500 through the common error response", async () => {
    const res = await get("broken");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
  });
});
