import { findAlert } from "@/lib/alerts/store";
import { runAlert } from "@/lib/alerts/run";
import { markExecutionLost, runExecutionJob } from "@/lib/executions/store";
import { JobFailure, registerJobHandler } from "./worker";

/**
 * The job kinds this image knows (docs/CONTEXT.md §4.40), registered once at boot. `ping`
 * is the proof of the loop; `execution` runs a bot's request the studio approved (§4.10),
 * once, and marks it lost rather than running it again when the worker died mid-run;
 * `alert` runs one alert the scheduler handed over (§4.29).
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
  registerJobHandler("alert", async (job) => {
    const record = await findAlert(text(job, "alertId"));
    if (!record) throw new JobFailure("not_found");
    const state = await runAlert(record);
    return { status: state.status, ...(state.lastValue !== undefined ? { value: state.lastValue } : {}) };
  });
}
