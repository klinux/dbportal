import { NextResponse } from "next/server";
import { channelInUse } from "@/lib/alerts/store";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerAlertError } from "@/lib/api/alerts";
import { deleteChannel } from "@/lib/channels/store";

type Params = { params: Promise<{ id: string }> };

/** Delete a stored channel (docs/CONTEXT.md §4.29); one an alert still names is refused. Admin only. */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/channels/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await deleteChannel(id, channelInUse);
    emitAuditEvent({
      type: "notification_channel",
      action: "deleted",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
