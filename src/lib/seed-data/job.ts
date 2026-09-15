import { randomUUID } from "node:crypto";
import type { AccessSession } from "@/lib/access";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { enqueueJob, getJob, listJobs } from "@/lib/jobs/queue";
import { withNamedRoles } from "@/lib/roles/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import type { JobRecord } from "@/lib/storage/types";
import { readCatalog } from "./catalog";
import { SeedDataError } from "./errors";
import { buildPlan, readCounts, readRatios, type PlanTable } from "./plan";
import { assertSeedable, runSeedNow, type SeedMode, type SeedRun } from "./run";

/**
 * A seed as a job (docs/CONTEXT.md §4.40): the route validates and enqueues, a worker runs
 * it and writes each table's progress on the job, and the status route reads the job back
 * as the run. The payload carries the session's principals as they were when the seed was
 * asked, so the worker opens the datasources the way the person could; the id of the job
 * is the id of the run, so the panel keeps polling the id it was given.
 */
export interface SeedJobPayload {
  session: AccessSession & { username: string };
  datasourceId: string;
  schema: string;
  counts: Record<string, number>;
  ratios: Record<string, number>;
  mode: SeedMode;
  sourceDatasourceId?: string;
  truncate: boolean;
  /** The run as it looks before a worker takes it: what the status route answers meanwhile. */
  run: SeedRun;
}

export interface SeedRequest {
  datasourceId: string;
  schema: string;
  counts: Map<string, number>;
  ratios: Map<string, number>;
  mode: SeedMode;
  sourceDatasourceId?: string;
  truncate: boolean;
}

/** The run before it ran: every table at zero, the counts as asked, no worker yet. */
export function queuedRun(
  id: string,
  request: SeedRequest,
  plan: PlanTable[],
  names: { target: string; source?: string },
  actor: string,
): SeedRun {
  return {
    id,
    datasourceId: request.datasourceId,
    datasourceName: names.target,
    schema: request.schema,
    mode: request.mode,
    ...(names.source ? { sourceName: names.source } : {}),
    truncated: request.truncate,
    status: "queued",
    startedBy: actor,
    startedAt: new Date().toISOString(),
    tables: plan.map((t) => ({
      name: t.name,
      target: request.ratios.has(t.name) ? 0 : (request.counts.get(t.name) ?? 0),
      inserted: 0,
    })),
  };
}

/** Hand a validated seed to the queue; one at a time per datasource, as the in-process run was. */
export async function enqueueSeed(
  request: SeedRequest,
  plan: PlanTable[],
  names: { target: string; source?: string },
  session: AccessSession & { username: string },
): Promise<SeedRun> {
  for (const status of ["queued", "running"] as const) {
    const open = await listJobs({ kind: "seed", status, limit: 100 });
    if (open.some((j) => (j.payload as { datasourceId?: string }).datasourceId === request.datasourceId)) {
      throw new SeedDataError(`A seed is already ${status} on "${names.target}"`, 409);
    }
  }
  const run = queuedRun(randomUUID(), request, plan, names, session.username);
  const payload: SeedJobPayload = {
    session: { role: session.role, username: session.username, groups: session.groups, namedRoles: session.namedRoles },
    datasourceId: request.datasourceId,
    schema: request.schema,
    counts: Object.fromEntries(request.counts),
    ratios: Object.fromEntries(request.ratios),
    mode: request.mode,
    ...(request.sourceDatasourceId ? { sourceDatasourceId: request.sourceDatasourceId } : {}),
    truncate: request.truncate,
    run,
  };
  const job = await enqueueJob({
    kind: "seed",
    payload: payload as unknown as Record<string, unknown>,
    requestedBy: session.username,
    maxAttempts: 1,
  });
  // The job's id is the run's: the queue chose it, and the panel polls it.
  return { ...run, id: job.id };
}

/** The run as the queue tells it: the worker's snapshot, or the queued shape, or what a lost job leaves. */
export function runFromJob(job: JobRecord): SeedRun {
  const payload = job.payload as unknown as SeedJobPayload;
  const base: SeedRun = { ...payload.run, id: job.id };
  if (job.result && typeof job.result === "object" && "tables" in job.result) {
    return { ...(job.result as unknown as SeedRun), id: job.id };
  }
  if (job.status === "queued") return base;
  if (job.status === "running") return { ...base, status: "running" };
  const why =
    job.status === "lost"
      ? "The worker running this seed stopped answering"
      : `The seed did not run (${job.error ?? "error"})`;
  return {
    ...base,
    status: "failed",
    finishedAt: job.finishedAt,
    tables: base.tables.map((t) => ({ ...t, error: why })),
  };
}

export async function seedRunById(id: string): Promise<SeedRun | null> {
  const job = await getJob(id);
  return job && job.kind === "seed" ? runFromJob(job) : null;
}

/** The worker's side: resolve as the person would, read the catalog again, run, and keep the run on the job. */
export async function runSeedJob(job: JobRecord, progress: (run: SeedRun) => Promise<void>): Promise<SeedRun> {
  const payload = job.payload as unknown as SeedJobPayload;
  const session = await withNamedRoles(payload.session);
  const connection = await resolveConnection({ connectionId: `seed:${payload.datasourceId}` }, session);
  await assertSeedable(connection);
  const provider = await getOrCreateProvider(connection, { applicationName: applicationNameFor(session.username) });
  const tables = await readCatalog(provider, payload.schema);
  const plan = buildPlan(tables);
  const counts = readCounts(payload.counts, plan);
  const ratios = readRatios(payload.ratios, plan);
  let source: { runner: typeof provider; name: string } | undefined;
  if (payload.mode === "copy") {
    const sourceConnection = await resolveConnection({ connectionId: `seed:${payload.sourceDatasourceId}` }, session);
    source = {
      runner: await getOrCreateProvider(sourceConnection, {
        applicationName: applicationNameFor(session.username),
        readOnly: true,
      }),
      name: sourceConnection.name,
    };
  }
  return runSeedNow(
    {
      connection,
      runner: provider,
      schema: payload.schema,
      tables,
      counts,
      ratios,
      mode: payload.mode,
      source,
      truncate: payload.truncate,
      actor: session.username,
      runId: job.id,
    },
    progress,
  );
}
