import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { JobRecord } from "@/lib/storage/types";

/**
 * A backup as a job (docs/CONTEXT.md §4.40): what the route checks before the queue takes it
 * - the engine, the tool, restore never on production, the file's name and presence - one
 * job at a time per datasource, the job read back as an outcome in every state, and the
 * worker's side resolving the datasource as the administrator would before the tool runs.
 */
const jobs: JobRecord[] = [];
const enqueue = mock(
  async (input: { kind: string; payload: Record<string, unknown>; requestedBy: string; maxAttempts?: number }) => {
    const job = {
      id: `job-${jobs.length + 1}`,
      kind: input.kind,
      payload: input.payload,
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      requestedBy: input.requestedBy,
      createdAt: "x",
      runAt: "x",
    } as JobRecord;
    jobs.push(job);
    return job;
  },
);
mock.module("@/lib/jobs/queue", () => ({
  enqueueJob: enqueue,
  listJobs: async (q: { status: string }) => jobs.filter((j) => j.status === q.status),
}));
mock.module("@/lib/roles/store", () => ({
  withNamedRoles: async (s: unknown) => ({ ...(s as object), namedRoles: ["ops"] }),
}));
const resolved: unknown[] = [];
mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: async (body: { connectionId: string }, session: unknown) => {
    resolved.push(session);
    return { id: body.connectionId, seedId: body.connectionId.slice(5), name: "Stage", type: "postgres" };
  },
}));
let tool = true;
let files = [{ name: "2026-01-01T00-00-00Z.dump", size: 1, createdAt: "x" }];
const createBackup = mock(async (_c: unknown, actor: string) => ({ name: "new.dump", size: 2, createdAt: "y", actor }));
const restoreBackup = mock(async (_c: unknown, name: string, actor: string) => ({ name, size: 1, createdAt: "x", actor }));
const realStore = await import("@/lib/backups/store");
mock.module("@/lib/backups/store", () => ({
  ...realStore,
  toolAvailable: async () => tool,
  listBackups: async () => files,
  createBackup,
  restoreBackup,
}));
const { BackupError } = await import("@/lib/backups/errors");
const { backupOutcome, enqueueBackup, isBackupJob, openBackupJob, runBackupJob } = await import("@/lib/backups/job");

const stage = { id: "seed:stage", seedId: "stage", name: "Stage", type: "postgres", environment: "staging" } as never;
const prod = { ...(stage as object), name: "Prod", environment: "production" } as never;
const session = { role: "admin", username: "root", groups: ["ops"] } as never;
const refused = async (p: Promise<unknown>) => {
  const e = await p.catch((err) => err);
  expect(e).toBeInstanceOf(BackupError);
  return (e as { statusCode: number; message: string }).statusCode;
};

describe("backups as jobs", () => {
  beforeEach(() => {
    jobs.length = 0;
    resolved.length = 0;
    tool = true;
    files = [{ name: "2026-01-01T00-00-00Z.dump", size: 1, createdAt: "x" }];
    enqueue.mockClear();
    createBackup.mockClear();
    restoreBackup.mockClear();
  });

  test("a create is checked for the engine and the tool, then queued once, with the session's principals", async () => {
    const job = await enqueueBackup(stage, "create", session);
    expect(job).toMatchObject({ kind: "backup", maxAttempts: 1, requestedBy: "root" });
    expect(job.payload).toEqual({
      action: "create",
      datasourceId: "stage",
      datasourceName: "Stage",
      session: { role: "admin", username: "root", groups: ["ops"], namedRoles: undefined },
    });
    expect(await refused(enqueueBackup(stage, "create", session))).toBe(409);
    jobs[0].status = "running";
    expect(await refused(enqueueBackup(stage, "restore", session, "2026-01-01T00-00-00Z.dump"))).toBe(409);
    jobs[0].status = "done";
    tool = false;
    expect(await refused(enqueueBackup(stage, "create", session))).toBe(503);
    expect(await refused(enqueueBackup({ ...(stage as object), type: "mysql" } as never, "create", session))).toBe(400);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test("a restore is refused on production, with a malformed name, and for a file that is not there", async () => {
    expect(await refused(enqueueBackup(prod, "restore", session, "2026-01-01T00-00-00Z.dump"))).toBe(403);
    expect(await refused(enqueueBackup(stage, "restore", session, "../etc/passwd"))).toBe(400);
    expect(await refused(enqueueBackup(stage, "restore", session))).toBe(400);
    expect(await refused(enqueueBackup(stage, "restore", session, "2026-02-02T00-00-00Z.dump"))).toBe(404);
    const job = await enqueueBackup(stage, "restore", session, "2026-01-01T00-00-00Z.dump");
    expect(job.payload).toMatchObject({ action: "restore", name: "2026-01-01T00-00-00Z.dump" });
  });

  test("the outcome read off the job in every state, and the open job of a datasource", async () => {
    const job = await enqueueBackup(stage, "create", session);
    expect(backupOutcome(job)).toEqual({ jobId: "job-1", action: "create", status: "queued" });
    expect(await openBackupJob("stage")).toEqual({ jobId: "job-1", action: "create", status: "queued" });
    expect(await openBackupJob("other")).toBeNull();
    const done = { ...job, status: "done", result: { name: "n.dump", size: 3, createdAt: "z" } } as JobRecord;
    expect(backupOutcome(done).backup).toEqual({ name: "n.dump", size: 3, createdAt: "z" });
    expect(backupOutcome({ ...job, status: "failed", error: "BackupError" } as JobRecord).error).toContain(
      "backup failed (BackupError)",
    );
    expect(backupOutcome({ ...job, status: "failed" } as JobRecord).error).toContain("(error)");
    const restore = { ...job, status: "lost", payload: { ...job.payload, action: "restore" } } as JobRecord;
    expect(backupOutcome(restore).error).toContain("running this restore stopped answering");
    expect(isBackupJob(job)).toBe(true);
    expect(isBackupJob({ ...job, kind: "ping" })).toBe(false);
    expect(isBackupJob(null)).toBe(false);
  });

  test("the worker resolves the datasource as the administrator would, with named roles, then runs the tool", async () => {
    const create = await enqueueBackup(stage, "create", session);
    expect(await runBackupJob(create)).toMatchObject({ name: "new.dump", actor: "root" });
    expect(resolved[0]).toMatchObject({ username: "root", namedRoles: ["ops"] });
    expect((createBackup.mock.calls[0] as unknown[])[0]).toMatchObject({ seedId: "stage" });
    jobs[0].status = "done";
    const restore = await enqueueBackup(stage, "restore", session, "2026-01-01T00-00-00Z.dump");
    expect(await runBackupJob(restore)).toMatchObject({ name: "2026-01-01T00-00-00Z.dump", actor: "root" });
    expect((restoreBackup.mock.calls[0] as unknown[])[1]).toBe("2026-01-01T00-00-00Z.dump");
  });
});
