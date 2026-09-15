import { randomUUID } from "node:crypto";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { JobQuery, JobRecord, JobStatus } from "@/lib/storage/types";

/**
 * The job queue (docs/CONTEXT.md §4.40): what the studio hands to a worker instead of doing
 * inside the request - a bot's execution, a seed, an export, a backup, an alert run. One
 * table in the store; a worker claims a job atomically, leases it while it runs, and a
 * lease that expires puts the job back until its attempts run out. Needs server storage:
 * a `local` deployment has no queue, and nothing is enqueued there.
 */
export const JOB_PAYLOAD_MAX_BYTES = 256 * 1024;
export const DEFAULT_MAX_ATTEMPTS = 2;

export class JobError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "JobError";
  }
}

async function requireStore() {
  const store = isServerStorageEnabled() ? await getStorageProvider() : null;
  if (!store) throw new JobError("The job queue needs server storage: set STORAGE_PROVIDER to sqlite or postgres", 503);
  return store;
}

export function jobsAvailable(): boolean {
  return isServerStorageEnabled();
}

export interface EnqueueInput {
  kind: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  /** Not before this instant; now when absent. */
  runAt?: string;
  maxAttempts?: number;
}

const KIND_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

export async function enqueueJob(input: EnqueueInput): Promise<JobRecord> {
  if (!KIND_SHAPE.test(input.kind)) throw new JobError(`Job kind "${input.kind}" is malformed`, 400);
  const bytes = Buffer.byteLength(JSON.stringify(input.payload));
  if (bytes > JOB_PAYLOAD_MAX_BYTES)
    throw new JobError(`Job payload is larger than ${JOB_PAYLOAD_MAX_BYTES} bytes`, 413);
  const store = await requireStore();
  const now = new Date().toISOString();
  const record: JobRecord = {
    id: randomUUID(),
    kind: input.kind,
    payload: input.payload,
    status: "queued",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    requestedBy: input.requestedBy,
    createdAt: now,
    runAt: input.runAt ?? now,
  };
  await store.putJob(record);
  return record;
}

export async function getJob(id: string): Promise<JobRecord | null> {
  return (await requireStore()).getJob(id);
}

export async function listJobs(query: Partial<JobQuery>): Promise<JobRecord[]> {
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  return (await requireStore()).listJobs({ ...query, limit });
}

export async function countJobs(status: JobStatus): Promise<number> {
  return (await requireStore()).countJobs(status);
}

/** The job once it settled, polled for up to `waitMs`; the job as it is when it has not, null when unknown. */
export async function waitForJob(id: string, waitMs: number, stepMs = 300): Promise<JobRecord | null> {
  const deadline = Date.now() + waitMs;
  let job = await getJob(id);
  while (job && (job.status === "queued" || job.status === "running") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    job = await getJob(id);
  }
  return job;
}
