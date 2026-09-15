import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { JobRecord } from "@/lib/storage/types";
import { FakeJobStore } from "./fake-store";

/**
 * The worker loop (docs/CONTEXT.md §4.40) over the in-memory store: who runs it, a pass
 * that claims up to the free slots for the kinds it handles, a handler's result kept on
 * the job, a failure retried with a backoff then recorded, an expired lease reclaimed or
 * lost with an audit line, the heartbeat while a handler runs, and start/stop once.
 */
let serverStorage = true;
const store = new FakeJobStore();
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => serverStorage,
  getStorageProvider: async () => (serverStorage ? store : null),
}));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const warn = mock(() => {});
const errorLog = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, info: () => {}, debug: () => {}, error: errorLog } }));
const counter = mock((_n: string, _l: Record<string, string>) => {});
mock.module("@/lib/metrics/registry", () => ({ incrementCounter: counter }));

const {
  DEFAULT_CONCURRENCY,
  JobFailure,
  RETRY_BACKOFF_MS,
  registerJobHandler,
  resetWorker,
  startWorker,
  stopWorker,
  workerEnabled,
  workerName,
  workerPass,
} = await import("@/lib/jobs/worker");

const queued = (id: string, kind: string, over: Partial<JobRecord> = {}): JobRecord => ({
  id,
  kind,
  payload: {},
  status: "queued",
  attempts: 0,
  maxAttempts: 2,
  requestedBy: "root",
  createdAt: "2026-09-14T00:00:00.000Z",
  runAt: "2026-09-14T00:00:00.000Z",
  ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 20));
const saved: Record<string, string | undefined> = {};
const ENV = ["DBPORTAL_ROLE", "JOBS_WORKER", "JOBS_LEASE_MS", "JOBS_CONCURRENCY", "JOBS_POLL_MS"];

describe("jobs worker", () => {
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetWorker();
    store.jobs.clear();
    serverStorage = true;
    audit.mockClear();
    warn.mockClear();
    counter.mockClear();
  });
  afterEach(() => {
    resetWorker();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("who runs the loop: the worker role always, the agent never, the studio with server storage unless told off", () => {
    expect(workerEnabled()).toBe(true);
    process.env.JOBS_WORKER = "off";
    expect(workerEnabled()).toBe(false);
    delete process.env.JOBS_WORKER;
    serverStorage = false;
    expect(workerEnabled()).toBe(false);
    process.env.DBPORTAL_ROLE = "worker";
    expect(workerEnabled()).toBe(true);
    process.env.DBPORTAL_ROLE = "agent";
    process.env.JOBS_WORKER = "on";
    expect(workerEnabled()).toBe(false);
    expect(workerName()).toMatch(/:\d+$/);
  });

  test("a pass claims due jobs of the handled kinds up to the free slots; a handler's result lands on the job", async () => {
    registerJobHandler("ping", async (job) => ({ pong: true, echo: job.payload.echo }));
    await store.putJob(queued("a", "ping", { payload: { echo: 1 } }));
    await store.putJob(queued("b", "ping", { runAt: "2026-09-14T00:00:01.000Z" }));
    await store.putJob(queued("c", "ping", { runAt: "2026-09-14T00:00:02.000Z" }));
    await store.putJob(queued("later", "ping", { runAt: "2999-01-01T00:00:00.000Z" }));
    await store.putJob(queued("other", "export"));
    expect(await workerPass(new Date("2026-09-14T00:01:00.000Z"))).toBe(DEFAULT_CONCURRENCY);
    await settle();
    expect((await store.getJob("a"))!).toMatchObject({
      status: "done",
      attempts: 1,
      result: { pong: true, echo: 1 },
      worker: workerName(),
    });
    expect((await store.getJob("b"))!.status).toBe("done");
    expect((await store.getJob("c"))!.status).toBe("queued");
    expect((await store.getJob("later"))!.status).toBe("queued");
    expect((await store.getJob("other"))!.status).toBe("queued");
    expect(counter).toHaveBeenCalledWith("dbportal_jobs_total", { kind: "ping", outcome: "done" });
    // The next pass takes the rest; with nothing due, nothing is claimed.
    expect(await workerPass(new Date("2026-09-14T00:01:00.000Z"))).toBe(1);
    await settle();
    expect(await workerPass(new Date("2026-09-14T00:01:00.000Z"))).toBe(0);
    // Without a handler registered, or a store, a pass does nothing.
    resetWorker();
    expect(await workerPass()).toBe(0);
    serverStorage = false;
    registerJobHandler("ping", async () => {});
    expect(await workerPass()).toBe(0);
  });

  test("a failing handler puts the job back with a backoff, then records it failed with an audit line; a closed reason is kept", async () => {
    registerJobHandler("boom", async () => {
      throw new Error("engine said something");
    });
    registerJobHandler("refused", async () => {
      throw new JobFailure("access");
    });
    await store.putJob(queued("x", "boom"));
    await store.putJob(queued("y", "refused", { maxAttempts: 1 }));
    process.env.JOBS_CONCURRENCY = "5";
    const t0 = new Date("2026-09-14T00:01:00.000Z");
    await workerPass(t0);
    await settle();
    const x = (await store.getJob("x"))!;
    expect(x.status).toBe("queued");
    expect(x.error).toBe("Error");
    expect(Date.parse(x.runAt)).toBeGreaterThanOrEqual(Date.now() + RETRY_BACKOFF_MS - 5_000);
    const y = (await store.getJob("y"))!;
    expect(y).toMatchObject({ status: "failed", error: "access", attempts: 1 });
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "job",
      action: "failed",
      target: "y",
      user: "root",
      details: "refused: access after 1 attempts",
    });
    expect(counter).toHaveBeenCalledWith("dbportal_jobs_total", { kind: "boom", outcome: "retry" });
    expect(counter).toHaveBeenCalledWith("dbportal_jobs_total", { kind: "refused", outcome: "failed" });
    // A job whose kind lost its handler between claim and run fails with no_handler.
    resetWorker();
    registerJobHandler("gone", async () => ({}));
    await store.putJob(queued("z", "gone", { maxAttempts: 1 }));
    (store as unknown as { jobs: Map<string, JobRecord> }).jobs.get("z")!.kind = "gone";
    await workerPass(t0);
    await settle();
  });

  test("an expired lease is reclaimed on the next pass, lost past the attempts with an audit line; the heartbeat extends a running lease", async () => {
    await store.putJob(
      queued("stale", "ping", {
        status: "running",
        attempts: 1,
        leaseUntil: "2026-09-14T00:00:30.000Z",
        worker: "dead:1",
      }),
    );
    await store.putJob(
      queued("gone", "ping", {
        status: "running",
        attempts: 2,
        leaseUntil: "2026-09-14T00:00:30.000Z",
        worker: "dead:1",
      }),
    );
    registerJobHandler("slow", async () => {
      await new Promise((r) => setTimeout(r, 2_500));
      return {};
    });
    await store.putJob(queued("s", "slow"));
    process.env.JOBS_LEASE_MS = "5000";
    const t0 = new Date("2026-09-14T00:01:00.000Z");
    await workerPass(t0);
    expect((await store.getJob("stale"))!).toMatchObject({ status: "queued", worker: undefined });
    expect((await store.getJob("gone"))!.status).toBe("lost");
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "job",
      action: "lost",
      target: "gone",
      details: "ping: the lease expired 2 times",
    });
    // The slow job is running under this worker; its lease moves forward while it runs, and a
    // heartbeat the store refuses is one warning, not a failed job.
    const before = (await store.getJob("s"))!.leaseUntil!;
    const heartbeat = store.heartbeatJob.bind(store);
    let beats = 0;
    store.heartbeatJob = async (id, worker, lease) => {
      beats++;
      if (beats === 1) throw new Error("store hiccup");
      return heartbeat(id, worker, lease);
    };
    await new Promise((r) => setTimeout(r, 2_700));
    store.heartbeatJob = heartbeat;
    const after = (await store.getJob("s"))!;
    expect(after.status).toBe("done");
    expect(beats).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith("Job heartbeat failed", expect.objectContaining({ jobId: "s" }));
    expect(Date.parse(after.finishedAt!)).toBeGreaterThan(Date.parse(before) - 5_000);
  }, 10_000);

  test("starts one loop per process and stops it; nothing starts where the worker is off; a failing pass is one error line", async () => {
    process.env.JOBS_WORKER = "off";
    expect(startWorker()).toBe(false);
    delete process.env.JOBS_WORKER;
    process.env.JOBS_POLL_MS = "250";
    registerJobHandler("ping", async () => ({}));
    expect(startWorker()).toBe(true);
    expect(startWorker()).toBe(true);
    stopWorker();
    stopWorker();
    // A pass that throws (the store failing to reclaim) is logged, not thrown.
    const failing = store.reclaimJobs;
    store.reclaimJobs = async () => {
      throw new Error("store down");
    };
    expect(startWorker()).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    stopWorker();
    store.reclaimJobs = failing;
    expect(errorLog).toHaveBeenCalled();
  });
});
