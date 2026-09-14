import { NextResponse } from "next/server";
import { AlertError, deleteAlert, findAlert, mayManage } from "@/lib/alerts/store";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { admitAlert } from "../route";

type Params = { params: Promise<{ id: string }> };

/** One alert (docs/CONTEXT.md §4.29): replaced or deleted by its owner or an administrator. */
export async function PUT(request: Request, { params }: Params) {
  const route = "PUT /api/alerts/[id]";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const existing = await findAlert(id);
    if (!existing || !mayManage(existing, guard.session)) throw new AlertError(`Alert "${id}" not found`, 404);
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await admitAlert({ ...body, id }, guard.session);
    emitAuditEvent({
      type: "alert",
      action: "saved",
      target: record.id,
      user: guard.session.username,
      result: "success",
      details: `${record.datasource}; every ${record.everyMinutes} min`,
    });
    return NextResponse.json({ alert: record });
  } catch (error) {
    return answerAlertError(error, route);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/alerts/[id]";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const record = await deleteAlert(id, guard.session);
    emitAuditEvent({
      type: "alert",
      action: "deleted",
      target: record.id,
      user: guard.session.username,
      result: "success",
    });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
