import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { JobRecord } from "@/lib/storage/types";

/**
 * A seed as a job (docs/CONTEXT.md §4.40): the queued run the status route answers before a
 * worker takes it, one seed at a time per datasource, the run read back off the job in
 * every state, and the worker's side resolving the datasources as the person would.
 */
const jobs: JobRecord[] = [];
const enqueue = mock(
  async (input: { kind: string; payload: Record<string, unknown>; requestedBy: string; maxAttempts?: number }) => {
    const job = {
      id: "job-7",
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
  getJob: async (id: string) => jobs.find((j) => j.id === id) ?? null,
}));
mock.module("@/lib/roles/store", () => ({
  withNamedRoles: async (s: unknown) => ({ ...(s as object), namedRoles: ["ops"] }),
}));
const connections: Record<string, Record<string, unknown>> = {
  "seed:stage": { id: "seed:stage", seedId: "stage", name: "Stage", type: "postgres", environment: "staging" },
  "seed:prod": { id: "seed:prod", seedId: "prod", name: "Prod", type: "postgres", environment: "production" },
};
const resolved: unknown[] = [];
mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: async (body: { connectionId: string }, session: unknown) => {
    resolved.push(session);
    const c = connections[body.connectionId];
    if (!c) throw new Error("not found");
    return c;
  },
}));
const providers: unknown[] = [];
mock.module("@/lib/db", () => ({
  getOrCreateProvider: async (_c: unknown, options: unknown) => {
    providers.push(options);
    return { query: async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 0 }) };
  },
}));
const tables = [{ name: "customers", columns: [] }];
mock.module("@/lib/seed-data/catalog", () => ({ readCatalog: async () => tables }));
const realRun = await import("@/lib/seed-data/run");
const runSeedNow = mock(async (input: Record<string, unknown>, onProgress?: (run: unknown) => Promise<void>) => {
  await onProgress?.({ id: input.runId, status: "running", tables: [{ name: "customers", target: 3, inserted: 1 }] });
  return { id: input.runId, status: "done", tables: [{ name: "customers", target: 3, inserted: 3 }] };
});
mock.module("@/lib/seed-data/run", () => ({ ...realRun, runSeedNow, assertSeedable: async () => {} }));

const { enqueueSeed, queuedRun, runFromJob, runSeedJob, seedRunById } = await import("@/lib/seed-data/job");
const plan = [
  { name: "customers", columns: 1, dependsOn: [], rows: 100 },
  { name: "orders", columns: 2, dependsOn: ["customers"], rows: 100 },
];
const request = {
  datasourceId: "stage",
  schema: "public",
  counts: new Map([
    ["customers", 3],
    ["orders", 50],
  ]),
  ratios: new Map([["orders", 2]]),
  mode: "copy" as const,
  sourceDatasourceId: "prod",
  truncate: true,
};
const session = { role: "admin", username: "root", groups: ["sre"] };

describe("seed job", () => {
  beforeEach(() => {
    jobs.length = 0;
    resolved.length = 0;
    providers.length = 0;
    enqueue.mockClear();
    runSeedNow.mockClear();
  });

  test("the queued run: the counts as asked, zero for a table by ratio, the names, no worker yet", () => {
    const run = queuedRun("r1", request, plan, { target: "Stage", source: "Prod" }, "root");
    expect(run).toMatchObject({
      id: "r1",
      datasourceId: "stage",
      datasourceName: "Stage",
      sourceName: "Prod",
      mode: "copy",
      truncated: true,
      status: "queued",
      startedBy: "root",
      tables: [
        { name: "customers", target: 3, inserted: 0 },
        { name: "orders", target: 0, inserted: 0 },
      ],
    });
    expect(
      queuedRun(
        "r2",
        { ...request, mode: "generate", sourceDatasourceId: undefined },
        plan,
        { target: "Stage" },
        "root",
      ),
    ).not.toHaveProperty("sourceName");
  });

  test("enqueueSeed hands the payload to the queue under the job's id, and refuses a second seed on a datasource with one open", async () => {
    const run = await enqueueSeed(request, plan, { target: "Stage", source: "Prod" }, session);
    expect(run.id).toBe("job-7");
    expect(run.status).toBe("queued");
    const input = enqueue.mock.calls[0][0];
    expect(input).toMatchObject({ kind: "seed", requestedBy: "root", maxAttempts: 1 });
    expect(input.payload).toMatchObject({
      session: { role: "admin", username: "root", groups: ["sre"] },
      datasourceId: "stage",
      schema: "public",
      counts: { customers: 3, orders: 50 },
      ratios: { orders: 2 },
      mode: "copy",
      sourceDatasourceId: "prod",
      truncate: true,
    });
    await expect(enqueueSeed(request, plan, { target: "Stage" }, session)).rejects.toThrow("already queued");
    jobs[0].status = "running";
    await expect(enqueueSeed(request, plan, { target: "Stage" }, session)).rejects.toThrow("already running");
    jobs[0].status = "done";
    expect(
      (await enqueueSeed({ ...request, datasourceId: "other" }, plan, { target: "Other" }, session)).datasourceId,
    ).toBe("other");
  });

  test("the run read off the job: the worker's snapshot when there is one, else the queued shape, running, or what a lost or failed job leaves", async () => {
    const run = await enqueueSeed(request, plan, { target: "Stage", source: "Prod" }, session);
    const job = jobs[0];
    expect((await seedRunById("job-7"))!).toMatchObject({ id: "job-7", status: "queued", tables: run.tables });
    job.status = "running";
    expect(runFromJob(job).status).toBe("running");
    job.result = { id: "other", status: "running", tables: [{ name: "customers", target: 3, inserted: 2 }] };
    expect(runFromJob(job)).toMatchObject({ id: "job-7", status: "running", tables: [{ inserted: 2 }] });
    job.result = undefined;
    job.status = "lost";
    expect(runFromJob(job).tables.every((t) => t.error === "The worker running this seed stopped answering")).toBe(
      true,
    );
    job.status = "failed";
    job.error = "no_handler";
    const failed = runFromJob(job);
    expect(failed.status).toBe("failed");
    expect(failed.tables.map((t) => t.error)).toEqual([
      "The seed did not run (no_handler)",
      "The seed did not run (no_handler)",
    ]);
    job.error = undefined;
    expect(runFromJob(job).tables[0].error).toBe("The seed did not run (error)");
    expect(await seedRunById("ghost")).toBeNull();
    jobs.push({ ...job, id: "not-seed", kind: "ping" });
    expect(await seedRunById("not-seed")).toBeNull();
  });

  test("runSeedJob resolves as the person with named roles, reads the catalog, opens the source read-only, runs under the job's id and reports progress", async () => {
    await enqueueSeed(request, plan, { target: "Stage", source: "Prod" }, session);
    const snapshots: unknown[] = [];
    const run = await runSeedJob(jobs[0], async (s) => {
      snapshots.push(s);
    });
    expect(run).toMatchObject({ id: "job-7", status: "done" });
    expect(snapshots).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ username: "root", namedRoles: ["ops"] });
    expect(providers[1]).toMatchObject({ readOnly: true });
    const input = runSeedNow.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({ schema: "public", mode: "copy", truncate: true, actor: "root", runId: "job-7" });
    expect(input.counts).toEqual(new Map([["customers", 3]]));
    expect(input.ratios).toEqual(new Map());
    expect((input.source as { name: string }).name).toBe("Prod");
    // Generate mode opens no source.
    runSeedNow.mockClear();
    providers.length = 0;
    jobs[0].payload = { ...jobs[0].payload, mode: "generate", sourceDatasourceId: undefined, ratios: {} };
    await runSeedJob(jobs[0], async () => {});
    expect(providers).toHaveLength(1);
    expect((runSeedNow.mock.calls[0][0] as Record<string, unknown>).source).toBeUndefined();
  });
});
