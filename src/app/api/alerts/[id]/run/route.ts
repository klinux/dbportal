import { NextResponse } from "next/server";
import { AlertError, findAlert, mayManage, updateAlertState, waitForAlertRun } from "@/lib/alerts/store";
import { enqueueJob } from "@/lib/jobs/queue";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";

type Params = { params: Promise<{ id: string }> };

/** How long the route waits for the worker before answering that the run is queued. */
export const RUN_NOW_WAIT_MS = 15_000;

/**
 * Run one alert now (docs/CONTEXT.md §4.29): handed to the queue (§4.40) as its schedule
 * would hand it; the state it lands in comes back when a worker ran it within the wait,
 * else 202 and the job id - the list shows the outcome on its next refresh.
 */
export async function POST(request: Request, context: Params) {
  const route = "POST /api/alerts/[id]/run";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await context.params;
    const record = await findAlert(id);
    if (!record || !mayManage(record, guard.session)) throw new AlertError(`Alert "${id}" not found`, 404);
    const since = new Date().toISOString();
    const job = await enqueueJob({
      kind: "alert",
      payload: { alertId: id },
      requestedBy: guard.session.username,
      maxAttempts: 1,
    });
    await updateAlertState(id, { ...record.state, lastScheduledAt: since });
    const state = await waitForAlertRun(id, since, RUN_NOW_WAIT_MS);
    if (state) return NextResponse.json({ state });
    return NextResponse.json({ queued: true, jobId: job.id }, { status: 202 });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
