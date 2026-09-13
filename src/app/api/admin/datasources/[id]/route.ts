import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { deleteSharedDatasource, toSharedDatasourceView, updateSharedDatasource } from "@/lib/datasources/store";
import { answerSharedDatasourceError, readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const route = "PUT /api/admin/datasources/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;

  try {
    const { id } = await params;
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });

    const record = await updateSharedDatasource(id, body, gate.session.username);
    emitAuditEvent({
      type: "managed_connection",
      action: "updated",
      target: record.id,
      connectionName: record.name,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Shared datasource updated", { route, connectionId: record.id, user: gate.session.username });
    return NextResponse.json({ datasource: toSharedDatasourceView(record) });
  } catch (error) {
    return answerSharedDatasourceError(error, route);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<NextResponse> {
  const route = "DELETE /api/admin/datasources/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;

  try {
    const { id } = await params;
    const record = await deleteSharedDatasource(id);
    emitAuditEvent({
      type: "managed_connection",
      action: "deleted",
      target: record.id,
      connectionName: record.name,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Shared datasource deleted", { route, connectionId: record.id, user: gate.session.username });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return answerSharedDatasourceError(error, route);
  }
}
