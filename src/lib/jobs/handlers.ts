import { findAlert } from "@/lib/alerts/store";
import { runAlert } from "@/lib/alerts/run";
import { runBackupJob } from "@/lib/backups/job";
import { markExecutionLost, runExecutionJob } from "@/lib/executions/store";
import { runExport } from "@/lib/export/job";
import { runSeedJob } from "@/lib/seed-data/job";
import type { ExportJobPayload } from "@/lib/export/request";
import { JobFailure, registerJobHandler } from "./worker";

/**
 * The job kinds this image knows (docs/CONTEXT.md §4.40), registered once at boot. `ping`
 * is the proof of the loop; `execution` runs a bot's request the studio approved (§4.10),
 * once, and marks it lost rather than running it again when the worker died mid-run;
 * `alert` runs one alert the scheduler handed over (§4.29); `seed` fills a datasource
 * (§4.23, §4.31), the run kept on the job as it goes; `export` builds a result's file (§4.22);
 * `backup` runs pg_dump or pg_restore on one datasource (§4.14), the file its result.
 */
function text(job: { payload: Record<string, unknown> }, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value) throw new JobFailure(`no_${key}`);
  return value;
}

export function registerJobHandlers(): void {
  registerJobHandler("ping", async (job) => ({ pong: new Date().toISOString(), echo: job.payload.echo ?? null }));
  registerJobHandler(
    "execution",
    async (job) => {
      const record = await runExecutionJob(text(job, "approvalId"));
      if (!record) throw new JobFailure("not_found");
      return { status: record.execution?.status ?? "queued" };
    },
    async (job) => markExecutionLost(text(job, "approvalId")),
  );
  // A seed (§4.23, §4.31): the run is the job's result, written after every table.
  registerJobHandler("seed", async (job, context) => {
    const run = await runSeedJob(job, (snapshot) => context.progress(snapshot as unknown as Record<string, unknown>));
    return run as unknown as Record<string, unknown>;
  });
  // An export (§4.22): the file lands under EXPORT_DIR, the result says where and how big.
  registerJobHandler("export", async (job) => {
    const result = await runExport(job.payload as unknown as ExportJobPayload, job.id);
    return result as unknown as Record<string, unknown>;
  });
  // A backup or a restore (§4.14): the tool runs where the worker is, the file under BACKUP_DIR.
  registerJobHandler("backup", async (job) => (await runBackupJob(job)) as unknown as Record<string, unknown>);
  registerJobHandler("alert", async (job) => {
    const record = await findAlert(text(job, "alertId"));
    if (!record) throw new JobFailure("not_found");
    const state = await runAlert(record);
    return { status: state.status, ...(state.lastValue !== undefined ? { value: state.lastValue } : {}) };
  });
}
