import { describe, test, expect, mock } from "bun:test";
import type { JobRecord } from "@/lib/storage/types";

/**
 * The queue's statistics (docs/CONTEXT.md §4.40): settled jobs inside the window counted by
 * outcome and kind, the wait and the run as percentiles, the workers seen, and nothing from
 * a job still open or older than the window; the reader bounds the window and the sample.
 */
const listed: JobRecord[] = [];
const listJobs = mock(async (_q: { limit: number }) => listed);
mock.module("@/lib/jobs/queue", () => ({
  listJobs,
  countJobs: async (status: string) => (status === "queued" ? 4 : 1),
}));
const { DEFAULT_STATS_HOURS, MAX_STATS_HOURS, STATS_SAMPLE, computeJobStats, jobStats } = await import(
  "@/lib/jobs/stats"
);

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 15, 12, minutes)).toISOString();
const job = (id: string, over: Partial<JobRecord>): JobRecord => ({
  id,
  kind: "export",
  payload: {},
  status: "done",
  attempts: 1,
  maxAttempts: 1,
  requestedBy: "ana",
  createdAt: at(0),
  runAt: at(0),
  ...over,
});
const now = new Date(Date.UTC(2026, 8, 15, 13, 0));

describe("job statistics", () => {
  test("counts settled jobs in the window by outcome and kind, with wait and run percentiles and the workers seen", () => {
    const jobs = [
      job("a", { startedAt: at(1), finishedAt: at(3), worker: "w1" }),
      job("b", { startedAt: at(2), finishedAt: at(12), worker: "w2" }),
      job("c", { kind: "backup", status: "failed", startedAt: at(4), finishedAt: at(5), worker: "w1", error: "BackupError" }),
      job("d", { kind: "backup", status: "lost" }),
      job("e", { status: "running", startedAt: at(6) }),
      job("f", { status: "queued" }),
      job("g", { createdAt: at(-120), startedAt: at(-119), finishedAt: at(-118), worker: "old" }),
    ];
    const stats = computeJobStats(jobs, { queued: 2, running: 1 }, new Date(Date.UTC(2026, 8, 15, 11, 0)), 2);
    expect(stats).toMatchObject({
      hours: 2,
      sample: 7,
      queued: 2,
      running: 1,
      total: 4,
      done: 2,
      failed: 1,
      lost: 1,
    });
    // a waited 1 min, b 2, c 4: p50 is the second of three sorted, p95 the last.
    expect(stats.wait).toEqual({ p50Ms: 120_000, p95Ms: 240_000, maxMs: 240_000 });
    expect(stats.run).toEqual({ p50Ms: 120_000, p95Ms: 600_000, maxMs: 600_000 });
    // Most settled first, then by name: a tie between the two kinds falls to the name.
    expect(stats.kinds.map((k) => [k.kind, k.total, k.failed, k.lost])).toEqual([
      ["backup", 2, 1, 1],
      ["export", 2, 0, 0],
    ]);
    expect(stats.kinds[0].run).toEqual({ p50Ms: 60_000, p95Ms: 60_000, maxMs: 60_000 });
    expect(stats.workers).toEqual([
      { name: "w2", jobs: 1, lastSeenAt: at(12) },
      { name: "w1", jobs: 2, lastSeenAt: at(5) },
    ]);
  });

  test("an empty window has null percentiles and no kinds; a job without instants counts but measures nothing", () => {
    const empty = computeJobStats([], { queued: 0, running: 0 }, now, 24);
    expect(empty).toMatchObject({ total: 0, wait: null, run: null, kinds: [], workers: [] });
    const bare = computeJobStats([job("x", { status: "failed" })], { queued: 0, running: 0 }, new Date(0), 24);
    expect(bare.total).toBe(1);
    expect(bare.kinds[0]).toMatchObject({ kind: "export", failed: 1, wait: null, run: null });
    // An instant that is not one, or a finish before the start, measures nothing either.
    const odd = computeJobStats(
      [job("y", { startedAt: "not-a-date", finishedAt: at(1) }), job("z", { startedAt: at(5), finishedAt: at(1) })],
      { queued: 0, running: 0 },
      new Date(0),
      24,
    );
    expect(odd.wait).toEqual({ p50Ms: 300_000, p95Ms: 300_000, maxMs: 300_000 });
    expect(odd.run).toBeNull();
  });

  test("the reader bounds the window to [1, 30 days], reads the latest sample and the counts now", async () => {
    listed.length = 0;
    listed.push(job("a", { startedAt: at(1), finishedAt: at(2), worker: "w1" }));
    const stats = await jobStats(undefined, now);
    expect(stats).toMatchObject({ hours: DEFAULT_STATS_HOURS, queued: 4, running: 1, total: 1, sample: 1 });
    expect(listJobs.mock.calls[0][0]).toEqual({ limit: STATS_SAMPLE });
    expect((await jobStats(0.5, now)).hours).toBe(1);
    expect((await jobStats(99_999, now)).hours).toBe(MAX_STATS_HOURS);
    expect((await jobStats(6.7, now)).since).toBe(new Date(now.getTime() - 6 * 3_600_000).toISOString());
  });
});
