import { describe, test, expect, mock, beforeEach } from "bun:test";
import { FakeJobStore } from "./fake-store";

/** The queue's front door (docs/CONTEXT.md §4.40): a job enqueued with its bounds, read back, listed and counted; nothing without server storage. */
let serverStorage = true;
const store = new FakeJobStore();
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => serverStorage,
  getStorageProvider: async () => (serverStorage ? store : null),
}));
const {
  DEFAULT_MAX_ATTEMPTS,
  JOB_PAYLOAD_MAX_BYTES,
  JobError,
  countJobs,
  enqueueJob,
  getJob,
  jobsAvailable,
  listJobs,
} = await import("@/lib/jobs/queue");

describe("jobs queue", () => {
  beforeEach(() => {
    serverStorage = true;
    store.jobs.clear();
  });

  test("enqueues with the defaults, reads back, lists newest first with a bounded limit, and counts", async () => {
    const job = await enqueueJob({ kind: "ping", payload: { echo: "hi" }, requestedBy: "root" });
    expect(job).toMatchObject({
      kind: "ping",
      status: "queued",
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      requestedBy: "root",
    });
    expect(job.runAt).toBe(job.createdAt);
    expect(await getJob(job.id)).toEqual(job);
    const later = await enqueueJob({
      kind: "ping",
      payload: {},
      requestedBy: "root",
      runAt: "2999-01-01T00:00:00.000Z",
      maxAttempts: 5,
    });
    expect(later.maxAttempts).toBe(5);
    expect((await listJobs({ limit: 1 })).map((j) => j.id)).toEqual([later.id]);
    expect((await listJobs({ status: "queued", kind: "ping", limit: 0 })).length).toBe(1);
    expect(await countJobs("queued")).toBe(2);
    expect(await getJob("ghost")).toBeNull();
    expect(jobsAvailable()).toBe(true);
  });

  test("refuses a malformed kind, an oversized payload, and any use without server storage", async () => {
    await expect(enqueueJob({ kind: "Not Valid", payload: {}, requestedBy: "root" })).rejects.toThrow(JobError);
    const big = { blob: "x".repeat(JOB_PAYLOAD_MAX_BYTES) };
    const err = await enqueueJob({ kind: "ping", payload: big, requestedBy: "root" }).catch((e) => e);
    expect(err.statusCode).toBe(413);
    serverStorage = false;
    expect(jobsAvailable()).toBe(false);
    const none = await enqueueJob({ kind: "ping", payload: {}, requestedBy: "root" }).catch((e) => e);
    expect(none.statusCode).toBe(503);
    await expect(countJobs("queued")).rejects.toThrow("server storage");
  });
});
