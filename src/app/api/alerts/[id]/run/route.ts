import { NextResponse } from "next/server";
import { runAlert } from "@/lib/alerts/run";
import { AlertError, findAlert, mayManage } from "@/lib/alerts/store";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";

type Params = { params: Promise<{ id: string }> };

/** Run one alert now (docs/CONTEXT.md §4.29), as its schedule would; the state it lands in comes back. */
export async function POST(request: Request, context: Params) {
  const route = "POST /api/alerts/[id]/run";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await context.params;
    const record = await findAlert(id);
    if (!record || !mayManage(record, guard.session)) throw new AlertError(`Alert "${id}" not found`, 404);
    return NextResponse.json({ state: await runAlert(record) });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
