import { hostname } from "node:os";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { incrementCounter, observeHistogram } from "@/lib/metrics/registry";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { JobRecord } from "@/lib/storage/types";

/**
 * The worker loop (docs/CONTEXT.md §4.40): one per process, polling the queue for the kinds
 * this process has a handler for, up to `concurrency` jobs at a time, each leased and the
 * lease renewed while the handler runs. A handler that throws puts the job back with a
 * backoff until its attempts run out, then marks it failed; a worker that dies leaves a
 * lease that expires, and the next pass of any worker reclaims the job. Held on globalThis
 * like the other per-process state, so every Next.js entry sees the one loop.
 *
 * Who runs it: the `worker` role always; the studio too by default (JOBS_WORKER=auto), so
 * a single-instance install still executes what it enqueues; never the agent role.
 */
/** What a handler may do while it runs: write a snapshot of its progress on the job, for whoever reads the queue. */
export interface JobContext {
  progress(result: Record<string, unknown>): Promise<void>;
}
export type JobHandler = (job: JobRecord, context: JobContext) => Promise<Record<string, unknown> | void>;
/** What a kind does when a job of it is lost for good - a run whose outcome nobody knows. */
export type JobLostHandler = (job: JobRecord) => Promise<void>;

/** A failure the handler explains with a closed word; anything else is recorded by its name. */
export class JobFailure extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "JobFailure";
  }
}

export const DEFAULT_POLL_MS = 2_000;
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_CONCURRENCY = 2;
export const RETRY_BACKOFF_MS = 30_000;
export const DEFAULT_RETENTION_DAYS = 7;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;

const KEY = Symbol.for("dbportal.job-worker");
interface State {
  handlers: Map<string, JobHandler>;
  onLost: Map<string, JobLostHandler>;
  timer: ReturnType<typeof setInterval> | null;
  running: Set<string>;
  name: string;
  lastPruneAt: number;
}
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  g[KEY] ??= {
    handlers: new Map(),
    onLost: new Map(),
    timer: null,
    running: new Set(),
    name: `${hostname()}:${process.pid}`,
    lastPruneAt: 0,
  };
  return g[KEY];
}

/** Tests only. */
export function resetWorker(): void {
  stopWorker();
  delete (globalThis as typeof globalThis & { [KEY]?: State })[KEY];
}

export function registerJobHandler(kind: string, handler: JobHandler, onLost?: JobLostHandler): void {
  state().handlers.set(kind, handler);
  if (onLost) state().onLost.set(kind, onLost);
}

export function workerName(): string {
  return state().name;
}

export function workerEnabled(): boolean {
  const flag = process.env.JOBS_WORKER?.trim().toLowerCase();
  const role = process.env.DBPORTAL_ROLE?.trim().toLowerCase();
  if (role === "worker") return true;
  if (role === "agent") return false;
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return isServerStorageEnabled();
}

function setting(name: string, fallback: number, floor: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= floor ? n : fallback;
}

async function runOne(job: JobRecord, leaseMs: number): Promise<void> {
  const s = state();
  const store = await getStorageProvider();
  if (!store) return;
  const handler = s.handlers.get(job.kind);
  // `lease` is what the heartbeat last set: a progress snapshot must not write back a shorter one.
  let lease = job.leaseUntil;
  const heartbeat = setInterval(
    () => {
      lease = new Date(Date.now() + leaseMs).toISOString();
      store.heartbeatJob(job.id, s.name, lease).catch((error: unknown) => {
        logger.warn("Job heartbeat failed", { route: "jobs/worker", jobId: job.id, error: (error as Error).name });
      });
    },
    Math.max(1_000, Math.floor(leaseMs / 3)),
  );
  const startedAt = new Date().toISOString();
  // The two latencies the operator watches (§4.40): how long the job waited, how long it ran.
  observeHistogram(
    "dbportal_job_wait_seconds",
    { kind: job.kind },
    Math.max(0, Date.now() - Date.parse(job.createdAt)) / 1000,
  );
  const context: JobContext = {
    progress: async (result) => {
      await store.putJob({ ...job, status: "running", startedAt, leaseUntil: lease, worker: s.name, result });
    },
  };
  try {
    if (!handler) throw new JobFailure("no_handler");
    const result = await handler(job, context);
    // The record keeps which worker finished it, for the operator reading the queue.
    await store.putJob({
      ...job,
      status: "done",
      startedAt,
      finishedAt: new Date().toISOString(),
      leaseUntil: undefined,
      worker: s.name,
      ...(result ? { result } : {}),
    });
    incrementCounter("dbportal_jobs_total", { kind: job.kind, outcome: "done" });
  } catch (error) {
    const reason = error instanceof JobFailure ? error.reason : error instanceof Error ? error.name : "error";
    const again = job.attempts < job.maxAttempts;
    await store.putJob({
      ...job,
      status: again ? "queued" : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      runAt: again ? new Date(Date.now() + RETRY_BACKOFF_MS).toISOString() : job.runAt,
      leaseUntil: undefined,
      worker: again ? undefined : s.name,
      error: reason,
    });
    incrementCounter("dbportal_jobs_total", { kind: job.kind, outcome: again ? "retry" : "failed" });
    logger.warn("Job failed", { route: "jobs/worker", jobId: job.id, kind: job.kind, reason, again });
    if (!again) {
      emitAuditEvent({
        type: "job",
        action: "failed",
        target: job.id,
        user: job.requestedBy,
        result: "failure",
        details: `${job.kind}: ${reason} after ${job.attempts} attempts`,
      });
    }
  } finally {
    clearInterval(heartbeat);
    s.running.delete(job.id);
    observeHistogram("dbportal_job_run_seconds", { kind: job.kind }, (Date.now() - Date.parse(startedAt)) / 1000);
  }
}

/** Days a settled job is kept for the statistics and the list; 0 keeps everything. */
export function retentionDays(): number {
  const raw = process.env.JOBS_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

/** Once an hour per process: settled jobs past the retention go; a store that refuses is one warning. */
export async function pruneIfDue(now: Date): Promise<number> {
  const s = state();
  const days = retentionDays();
  if (days === 0 || now.getTime() - s.lastPruneAt < PRUNE_EVERY_MS) return 0;
  s.lastPruneAt = now.getTime();
  const store = await getStorageProvider();
  if (!store) return 0;
  try {
    const gone = await store.pruneJobs(new Date(now.getTime() - days * 86_400_000).toISOString());
    if (gone > 0) logger.info("Settled jobs pruned", { route: "jobs/worker", gone, days });
    return gone;
  } catch (error) {
    logger.warn("Job prune failed", { route: "jobs/worker", error: (error as Error).name });
    return 0;
  }
}

/** One pass: reclaim what expired, then claim and run up to the free slots. Returns how many were claimed. */
export async function workerPass(now = new Date()): Promise<number> {
  const s = state();
  const store = await getStorageProvider();
  if (!store || s.handlers.size === 0) return 0;
  const leaseMs = setting("JOBS_LEASE_MS", DEFAULT_LEASE_MS, 5_000);
  const concurrency = setting("JOBS_CONCURRENCY", DEFAULT_CONCURRENCY, 1);
  await pruneIfDue(now);
  for (const job of await store.reclaimJobs(now.toISOString())) {
    logger.warn("Job lease expired", { route: "jobs/worker", jobId: job.id, kind: job.kind, status: job.status });
    if (job.status === "lost") {
      emitAuditEvent({
        type: "job",
        action: "lost",
        target: job.id,
        user: job.requestedBy,
        result: "failure",
        details: `${job.kind}: the lease expired ${job.attempts} times`,
      });
      const onLost = s.onLost.get(job.kind);
      if (onLost) {
        await onLost(job).catch((error: unknown) => {
          logger.error("Lost-job handler failed", error, { route: "jobs/worker", jobId: job.id });
        });
      }
    }
  }
  let claimed = 0;
  while (s.running.size < concurrency) {
    const job = await store.claimJob(
      [...s.handlers.keys()],
      s.name,
      now.toISOString(),
      new Date(now.getTime() + leaseMs).toISOString(),
    );
    if (!job) break;
    claimed++;
    // Counted before the handler starts, so this loop sees the slot taken at once.
    s.running.add(job.id);
    void runOne(job, leaseMs);
  }
  return claimed;
}

export function startWorker(): boolean {
  if (!workerEnabled()) return false;
  const s = state();
  if (s.timer) return true;
  const pollMs = setting("JOBS_POLL_MS", DEFAULT_POLL_MS, 250);
  s.timer = setInterval(() => {
    workerPass().catch((error: unknown) => {
      logger.error("Worker pass failed", error, { route: "jobs/worker" });
    });
  }, pollMs);
  s.timer.unref?.();
  logger.info("Job worker started", { route: "jobs/worker", worker: s.name, pollMs, kinds: [...s.handlers.keys()] });
  return true;
}

export function stopWorker(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}
