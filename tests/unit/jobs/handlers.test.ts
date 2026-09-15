import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * The handlers this image registers at boot (docs/CONTEXT.md §4.40): `ping` answers with the
 * time and the echo; `execution` runs the request the job names once and marks a lost one
 * on the record; `alert` runs the alert the job names. A job without its id, or naming
 * nothing, fails with a closed word.
 */
const handlers = new Map<string, (job: unknown) => Promise<unknown>>();
const lost = new Map<string, (job: unknown) => Promise<void>>();
const real = await import("@/lib/jobs/worker");
mock.module("@/lib/jobs/worker", () => ({
  ...real,
  registerJobHandler: (k: string, h: (job: unknown) => Promise<unknown>, l?: (job: unknown) => Promise<void>) => {
    handlers.set(k, h);
    if (l) lost.set(k, l);
  },
}));
let record: Record<string, unknown> | null = { id: "a1", execution: { status: "done" } };
const runExecutionJob = mock(async (_id: string) => record);
const markExecutionLost = mock(async (_id: string) => {});
mock.module("@/lib/executions/store", () => ({ runExecutionJob, markExecutionLost }));
let alert: Record<string, unknown> | null = { id: "slow" };
mock.module("@/lib/alerts/store", () => ({ findAlert: async (_id: string) => alert }));
const runAlert = mock(
  async (_a: unknown): Promise<{ status: string; lastValue?: string }> => ({ status: "firing", lastValue: "9" }),
);
mock.module("@/lib/alerts/run", () => ({ runAlert }));
const runSeedJob = mock(async (_job: unknown, progress: (run: unknown) => Promise<void>) => {
  await progress({ status: "running" });
  return { status: "done", tables: [] };
});
mock.module("@/lib/seed-data/job", () => ({ runSeedJob }));
const runExport = mock(async (_p: unknown, id: string) => ({ file: `/x/${id}.csv`, rows: 1 }));
mock.module("@/lib/export/job", () => ({ runExport }));
const runBackupJob = mock(async (_job: unknown) => ({ name: "n.dump", size: 3, createdAt: "z" }));
mock.module("@/lib/backups/job", () => ({ runBackupJob }));
let retention: number | null = 90;
mock.module("@/lib/audit-persistence", () => ({ retentionDays: () => retention }));
const maintain = mock(async (_now: Date, before: string | null) => ({
  created: ["p"],
  dropped: [],
  removed: before ? 3 : 0,
}));
let storeUp = true;
mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => (storeUp ? { maintainAuditStorage: maintain } : null),
}));
const { registerJobHandlers } = await import("@/lib/jobs/handlers");
const job = (payload: Record<string, unknown>) => ({ id: "j", kind: "x", payload });
const context = { progress: mock(async (_r: Record<string, unknown>) => {}) };

describe("job handlers", () => {
  beforeEach(() => {
    handlers.clear();
    lost.clear();
    registerJobHandlers();
    record = { id: "a1", execution: { status: "done" } };
    alert = { id: "slow" };
  });

  test("ping", async () => {
    expect([...handlers.keys()]).toEqual([
      "ping",
      "execution",
      "seed",
      "export",
      "backup",
      "audit-partitions",
      "alert",
    ]);
    const result = (await handlers.get("ping")!(job({ echo: "hi" }))) as { pong: string; echo: unknown };
    expect(Number.isNaN(Date.parse(result.pong))).toBe(false);
    expect(result.echo).toBe("hi");
    expect(((await handlers.get("ping")!(job({}))) as { echo: unknown }).echo).toBeNull();
  });

  test("execution: runs the request named once, reports its outcome, and marks a lost job on the record", async () => {
    expect(await handlers.get("execution")!(job({ approvalId: "a1" }))).toEqual({ status: "done" });
    expect(runExecutionJob).toHaveBeenLastCalledWith("a1");
    record = { id: "a2" };
    expect(await handlers.get("execution")!(job({ approvalId: "a2" }))).toEqual({ status: "queued" });
    record = null;
    await expect(handlers.get("execution")!(job({ approvalId: "ghost" }))).rejects.toThrow("not_found");
    await expect(handlers.get("execution")!(job({}))).rejects.toThrow("no_approvalId");
    await lost.get("execution")!(job({ approvalId: "a1" }));
    expect(markExecutionLost).toHaveBeenLastCalledWith("a1");
  });

  test("alert: runs the alert named and reports the state it landed in", async () => {
    expect(await handlers.get("alert")!(job({ alertId: "slow" }))).toEqual({ status: "firing", value: "9" });
    expect(runAlert).toHaveBeenLastCalledWith({ id: "slow" });
    runAlert.mockImplementationOnce(async () => ({ status: "ok" }));
    expect(await handlers.get("alert")!(job({ alertId: "slow" }))).toEqual({ status: "ok" });
    alert = null;
    await expect(handlers.get("alert")!(job({ alertId: "ghost" }))).rejects.toThrow("not_found");
  });

  test("seed: runs the job's seed and writes its progress on the job; the run is the result", async () => {
    const handler = handlers.get("seed")! as unknown as (job: unknown, context: unknown) => Promise<unknown>;
    expect(await handler(job({}), context)).toEqual({ status: "done", tables: [] });
    expect(context.progress).toHaveBeenCalledWith({ status: "running" });
    expect(runSeedJob.mock.calls[0][0]).toEqual(job({}));
  });

  test("export: builds the file for the job's payload under the job's id; the result says where", async () => {
    expect(await handlers.get("export")!({ id: "j9", kind: "export", payload: { sql: "SELECT 1" } })).toEqual({
      file: "/x/j9.csv",
      rows: 1,
    });
    expect(runExport.mock.calls[0]).toEqual([{ sql: "SELECT 1" }, "j9"]);
  });

  test("backup: runs the job's backup or restore; the file is the result", async () => {
    const job = { id: "j3", kind: "backup", payload: { action: "create" } };
    expect(await handlers.get("backup")!(job)).toEqual({ name: "n.dump", size: 3, createdAt: "z" });
    expect(runBackupJob.mock.calls[0]).toEqual([job]);
  });

  // The audit record's upkeep (§4.43): the store's own, with the retention instant or none.
  test("audit-partitions: the store's upkeep with the retention instant, none when retention is off, a closed word without a store", async () => {
    const handler = handlers.get("audit-partitions")!;
    expect(await handler({ id: "j4", kind: "audit-partitions", payload: {} })).toEqual({
      created: ["p"],
      dropped: [],
      removed: 3,
    });
    const before = (maintain.mock.calls[0] as unknown[])[1] as string;
    expect(Date.now() - Date.parse(before)).toBeGreaterThan(89 * 86_400_000);
    retention = null;
    await handler({ id: "j5", kind: "audit-partitions", payload: {} });
    expect((maintain.mock.calls[1] as unknown[])[1]).toBeNull();
    storeUp = false;
    await expect(handler({ id: "j6", kind: "audit-partitions", payload: {} })).rejects.toThrow("no_store");
    storeUp = true;
    retention = 90;
  });
});
