import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerRunbookError } from "@/lib/api/runbooks";
import { deleteRunbook } from "@/lib/runbooks/store";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/** Delete a runbook (docs/CONTEXT.md §4.20). */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/runbooks/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await deleteRunbook(id);
    emitAuditEvent({
      type: "runbook",
      action: "deleted",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Runbook deleted", { route, runbookId: record.id, user: gate.session.username });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerRunbookError(error, route);
  }
}
