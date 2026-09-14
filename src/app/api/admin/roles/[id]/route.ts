import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerNamedRoleError } from "@/lib/api/roles";
import { deleteNamedRole } from "@/lib/roles/store";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/** Delete a named role (docs/CONTEXT.md §4.19); every list that names it stops matching at once. */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/roles/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await deleteNamedRole(id);
    emitAuditEvent({
      type: "named_role",
      action: "deleted",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Named role deleted", { route, roleId: record.id, user: gate.session.username });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerNamedRoleError(error, route);
  }
}
