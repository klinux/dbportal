import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerFreezeError } from "@/lib/api/freezes";
import { deleteFreezeWindow } from "@/lib/freezes/store";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/** End a window early, or remove one that has not started (docs/CONTEXT.md §4.17). */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/freezes/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await deleteFreezeWindow(id);
    emitAuditEvent({
      type: "freeze_window",
      action: "deleted",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Freeze window deleted", { route, freezeId: record.id, user: gate.session.username });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerFreezeError(error, route);
  }
}
