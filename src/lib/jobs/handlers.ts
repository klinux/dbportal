import { registerJobHandler } from "./worker";

/**
 * The job kinds this image knows (docs/CONTEXT.md §4.40), registered once at boot. `ping`
 * is the proof of the loop - an administrator enqueues one and reads the answer back -
 * and the shape every other kind follows: a handler that takes the record and returns
 * what the job produced.
 */
export function registerJobHandlers(): void {
  registerJobHandler("ping", async (job) => ({ pong: new Date().toISOString(), echo: job.payload.echo ?? null }));
}
