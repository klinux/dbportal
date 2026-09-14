import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerNamedRoleError } from "@/lib/api/roles";
import { createNamedRole, listNamedRoles } from "@/lib/roles/store";
import { logger } from "@/lib/logger";

/** Named roles (docs/CONTEXT.md §4.19): list them with their source; declare one. Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/roles";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const roles = (await listNamedRoles()).map(({ role, source }) => ({ ...role, source }));
    return NextResponse.json({ roles });
  } catch (error) {
    return answerNamedRoleError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/roles";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await createNamedRole(body, gate.session.username);
    emitAuditEvent({
      type: "named_role",
      action: "created",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Named role created", { route, roleId: record.id, user: gate.session.username });
    return NextResponse.json({ role: { ...record, source: "store" } }, { status: 201 });
  } catch (error) {
    return answerNamedRoleError(error, route);
  }
}
