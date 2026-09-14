import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { ChannelError, findChannel, mayManageChannel } from "@/lib/channels/store";
import { deliverToChannel } from "@/lib/notify/channels";

type Params = { params: Promise<{ id: string }> };

/** A test message to a channel one declared (docs/CONTEXT.md §4.29); someone else's is not found. */
export async function POST(request: Request, { params }: Params) {
  const route = "POST /api/channels/[id]/test";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const channel = await findChannel(id);
    const actor = { username: guard.session.username, admin: guard.session.role === "admin" };
    if (!channel || !mayManageChannel(channel, actor)) throw new ChannelError(`Channel "${id}" not found`, 404);
    const delivered = await deliverToChannel(channel, {
      alertId: "test",
      alertName: "Test message",
      datasourceName: "dbportal",
      state: "test",
      condition: `sent by ${guard.session.username}`,
      at: new Date().toISOString(),
    });
    emitAuditEvent({
      type: "notification_channel",
      action: "tested",
      target: channel.id,
      user: guard.session.username,
      result: delivered ? "success" : "failure",
    });
    return NextResponse.json({ delivered });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
