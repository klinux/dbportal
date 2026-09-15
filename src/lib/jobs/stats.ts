import { ALERT_SCHEDULER_LEASE, instanceName, listLeases } from "@/lib/leases";
import type { JobRecord, LeaseRecord } from "@/lib/storage/types";
import { countJobs, listJobs } from "./queue";

/**
 * The queue's statistics (docs/CONTEXT.md §4.40) as the Jobs page and the operator read
 * them: what waits and runs now, and over a window - the last 24 hours by default - how
 * many jobs settled and how, how long they waited for a worker and how long a worker held
 * them, by kind, and which workers were seen. Computed here from the latest records rather
 * than in SQL, so both store providers answer the same numbers with no second query
 * dialect; the sample is bounded, and the answer says how many records it read.
 */
export const STATS_SAMPLE = 2_000;
export const DEFAULT_STATS_HOURS = 24;
export const MAX_STATS_HOURS = 30 * 24;

export interface Percentiles {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface JobKindStats {
  kind: string;
  total: number;
  done: number;
  failed: number;
  lost: number;
  wait: Percentiles | null;
  run: Percentiles | null;
}

export interface JobWorkerStats {
  name: string;
  jobs: number;
  lastSeenAt: string;
}

export interface JobStats {
  since: string;
  hours: number;
  /** How many records the window's numbers were read from; STATS_SAMPLE when the window held more. */
  sample: number;
  queued: number;
  running: number;
  total: number;
  done: number;
  failed: number;
  lost: number;
  wait: Percentiles | null;
  run: Percentiles | null;
  kinds: JobKindStats[];
  workers: JobWorkerStats[];
  /** The leases in the store (§4.41): who leads the alert scheduler, which cooldowns are running. */
  leases: LeaseRecord[];
  /** The instance that answered, as it names itself in a lease. */
  instance: string;
  /** Who holds the alert scheduler's lease now (§4.41); null when nobody does. */
  schedulerLeader: string | null;
}

export const SCHEDULER_LEASE_NAME = ALERT_SCHEDULER_LEASE;

function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted[sorted.length - 1] };
}

function ms(from?: string, to?: string): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

/** The window's numbers from the records given; `queued` and `running` are the queue's counts now. */
export function computeJobStats(
  jobs: JobRecord[],
  counts: { queued: number; running: number },
  since: Date,
  hours: number,
  leases: LeaseRecord[] = [],
  instance = "",
): JobStats {
  const sinceIso = since.toISOString();
  const nowIso = new Date(since.getTime() + hours * 3_600_000).toISOString();
  const settled = jobs.filter((j) => j.status !== "queued" && j.status !== "running" && j.createdAt >= sinceIso);
  const byKind = new Map<string, { jobs: JobRecord[]; wait: number[]; run: number[] }>();
  const workers = new Map<string, JobWorkerStats>();
  const wait: number[] = [];
  const run: number[] = [];
  for (const job of settled) {
    let entry = byKind.get(job.kind);
    if (!entry) {
      entry = { jobs: [], wait: [], run: [] };
      byKind.set(job.kind, entry);
    }
    entry.jobs.push(job);
    const waited = ms(job.createdAt, job.startedAt);
    if (waited !== null) {
      wait.push(waited);
      entry.wait.push(waited);
    }
    const ran = ms(job.startedAt, job.finishedAt);
    if (ran !== null) {
      run.push(ran);
      entry.run.push(ran);
    }
    if (job.worker && job.finishedAt) {
      const seen = workers.get(job.worker);
      if (!seen) workers.set(job.worker, { name: job.worker, jobs: 1, lastSeenAt: job.finishedAt });
      else {
        seen.jobs += 1;
        if (job.finishedAt > seen.lastSeenAt) seen.lastSeenAt = job.finishedAt;
      }
    }
  }
  const count = (list: JobRecord[], status: JobRecord["status"]) => list.filter((j) => j.status === status).length;
  const kinds: JobKindStats[] = [...byKind.entries()]
    .map(([kind, entry]) => ({
      kind,
      total: entry.jobs.length,
      done: count(entry.jobs, "done"),
      failed: count(entry.jobs, "failed"),
      lost: count(entry.jobs, "lost"),
      wait: percentiles(entry.wait),
      run: percentiles(entry.run),
    }))
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));
  return {
    since: sinceIso,
    hours,
    sample: jobs.length,
    queued: counts.queued,
    running: counts.running,
    total: settled.length,
    done: count(settled, "done"),
    failed: count(settled, "failed"),
    lost: count(settled, "lost"),
    wait: percentiles(wait),
    run: percentiles(run),
    kinds,
    workers: [...workers.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    leases,
    instance,
    schedulerLeader: leases.find((l) => l.name === SCHEDULER_LEASE_NAME && l.until > nowIso)?.holder ?? null,
  };
}

/** The statistics over the last `hours`, read from the queue. */
export async function jobStats(hours = DEFAULT_STATS_HOURS, now = new Date()): Promise<JobStats> {
  const window = Math.min(MAX_STATS_HOURS, Math.max(1, Math.floor(hours)));
  const [jobs, queued, running, leases] = await Promise.all([
    listJobs({ limit: STATS_SAMPLE }),
    countJobs("queued"),
    countJobs("running"),
    listLeases(),
  ]);
  return computeJobStats(
    jobs,
    { queued, running },
    new Date(now.getTime() - window * 3_600_000),
    window,
    leases,
    instanceName(),
  );
}
