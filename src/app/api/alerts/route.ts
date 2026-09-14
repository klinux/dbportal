import { NextResponse } from "next/server";
import { isReadStatement } from "@/lib/access";
import { AlertError, listAlerts, saveAlert, validateAlert } from "@/lib/alerts/store";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { findChannel } from "@/lib/channels/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import type { UserPayload } from "@/lib/auth";

/**
 * Alerts (docs/CONTEXT.md §4.29): the session's own (every one for an administrator), and
 * a new or replaced one. Saving proves what the run will need: the datasource opens for
 * this session, the statement reads, every channel is declared.
 */
export async function GET(request: Request) {
  const route = "GET /api/alerts";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    return NextResponse.json({ alerts: await listAlerts(guard.session) });
  } catch (error) {
    return answerAlertError(error, route);
  }
}

export async function admitAlert(body: Record<string, unknown>, session: UserPayload) {
  const data = validateAlert(body);
  const connection = await resolveConnection({ connectionId: `seed:${data.datasource}` }, session);
  if (!isReadStatement(data.sql, connection.type)) {
    throw new AlertError("Only a statement that reads may be an alert", 400);
  }
  for (const id of data.channels) {
    if (!(await findChannel(id))) throw new AlertError(`Channel "${id}" is not declared`, 400);
  }
  return saveAlert(data, session);
}

export async function POST(request: Request) {
  const route = "POST /api/alerts";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await admitAlert(body, guard.session);
    emitAuditEvent({
      type: "alert",
      action: "saved",
      target: record.id,
      user: guard.session.username,
      result: "success",
      details: `${record.datasource}; every ${record.everyMinutes} min`,
    });
    return NextResponse.json({ alert: record }, { status: 201 });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
