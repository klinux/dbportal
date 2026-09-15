import type { JobQuery, JobRecord, JobStatus } from "@/lib/storage/types";

/**
 * An in-memory job store with the queue's semantics (docs/CONTEXT.md §4.40): a claim takes
 * the oldest due job of the kinds asked, a heartbeat extends a lease held by the same
 * worker, a reclaim puts expired leases back or marks them lost. What both real providers
 * do in SQL, small enough to read in one go.
 */
export class FakeJobStore {
  jobs = new Map<string, JobRecord>();
  async putJob(record: JobRecord): Promise<void> {
    this.jobs.set(record.id, { ...record });
  }
  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }
  async listJobs(query: JobQuery): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => (!query.status || j.status === query.status) && (!query.kind || j.kind === query.kind))
      .sort((a, b) => b.runAt.localeCompare(a.runAt))
      .slice(0, query.limit);
  }
  async countJobs(status: JobStatus): Promise<number> {
    return [...this.jobs.values()].filter((j) => j.status === status).length;
  }
  async claimJob(kinds: string[], worker: string, now: string, leaseUntil: string): Promise<JobRecord | null> {
    const due = [...this.jobs.values()]
      .filter((j) => j.status === "queued" && j.runAt <= now && kinds.includes(j.kind))
      .sort((a, b) => a.runAt.localeCompare(b.runAt))[0];
    if (!due) return null;
    const claimed = { ...due, status: "running" as const, leaseUntil, worker, attempts: due.attempts + 1 };
    this.jobs.set(due.id, claimed);
    return claimed;
  }
  async heartbeatJob(id: string, worker: string, leaseUntil: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || job.worker !== worker) return false;
    job.leaseUntil = leaseUntil;
    return true;
  }
  async reclaimJobs(now: string): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || !job.leaseUntil || job.leaseUntil >= now) continue;
      const status: JobStatus = job.attempts >= job.maxAttempts ? "lost" : "queued";
      Object.assign(job, { status, leaseUntil: undefined, worker: undefined });
      out.push({ ...job });
    }
    return out;
  }
}
