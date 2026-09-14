import { NextResponse } from "next/server";
import { channelInUse } from "@/lib/alerts/store";
import { emitAuditEvent } from "@/lib/audit";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { deleteChannel } from "@/lib/channels/store";

type Params = { params: Promise<{ id: string }> };

/** Delete a channel one declared (docs/CONTEXT.md §4.29); someone else's, a seed-file one, or one an alert names is refused. */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/channels/[id]";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const record = await deleteChannel(id, channelInUse, {
      username: guard.session.username,
      admin: guard.session.role === "admin",
    });
    emitAuditEvent({
      type: "notification_channel",
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
