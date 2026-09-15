import { hostname } from "node:os";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { incrementCounter } from "@/lib/metrics/registry";
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
export type JobHandler = (job: JobRecord) => Promise<Record<string, unknown> | void>;

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

const KEY = Symbol.for("dbportal.job-worker");
interface State {
  handlers: Map<string, JobHandler>;
  timer: ReturnType<typeof setInterval> | null;
  running: Set<string>;
  name: string;
}
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  g[KEY] ??= { handlers: new Map(), timer: null, running: new Set(), name: `${hostname()}:${process.pid}` };
  return g[KEY];
}

/** Tests only. */
export function resetWorker(): void {
  stopWorker();
  delete (globalThis as typeof globalThis & { [KEY]?: State })[KEY];
}

export function registerJobHandler(kind: string, handler: JobHandler): void {
  state().handlers.set(kind, handler);
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
  const heartbeat = setInterval(
    () => {
      store.heartbeatJob(job.id, s.name, new Date(Date.now() + leaseMs).toISOString()).catch((error: unknown) => {
        logger.warn("Job heartbeat failed", { route: "jobs/worker", jobId: job.id, error: (error as Error).name });
      });
    },
    Math.max(1_000, Math.floor(leaseMs / 3)),
  );
  const startedAt = new Date().toISOString();
  try {
    if (!handler) throw new JobFailure("no_handler");
    const result = await handler(job);
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
  }
}

/** One pass: reclaim what expired, then claim and run up to the free slots. Returns how many were claimed. */
export async function workerPass(now = new Date()): Promise<number> {
  const s = state();
  const store = await getStorageProvider();
  if (!store || s.handlers.size === 0) return 0;
  const leaseMs = setting("JOBS_LEASE_MS", DEFAULT_LEASE_MS, 5_000);
  const concurrency = setting("JOBS_CONCURRENCY", DEFAULT_CONCURRENCY, 1);
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
