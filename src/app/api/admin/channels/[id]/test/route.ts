import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerAlertError } from "@/lib/api/alerts";
import { ChannelError, findChannel } from "@/lib/channels/store";
import { deliverToChannel } from "@/lib/notify/channels";

type Params = { params: Promise<{ id: string }> };

/** A test message to one channel (docs/CONTEXT.md §4.29), so a receiver is proven before an alert needs it. Admin only. */
export async function POST(request: Request, { params }: Params) {
  const route = "POST /api/admin/channels/[id]/test";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const channel = await findChannel(id);
    if (!channel) throw new ChannelError(`Channel "${id}" not found`, 404);
    const delivered = await deliverToChannel(channel, {
      alertId: "test",
      alertName: "Test message",
      datasourceName: "dbportal",
      state: "test",
      condition: `sent by ${gate.session.username}`,
      at: new Date().toISOString(),
    });
    emitAuditEvent({
      type: "notification_channel",
      action: "tested",
      target: channel.id,
      user: gate.session.username,
      result: delivered ? "success" : "failure",
    });
    return NextResponse.json({ delivered });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
