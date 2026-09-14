import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerAlertError } from "@/lib/api/alerts";
import { listChannels, saveChannel } from "@/lib/channels/store";
import { logger } from "@/lib/logger";

/** Notification channels (docs/CONTEXT.md §4.29): list them with their source and target; declare one. Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/channels";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const channels = (await listChannels()).map(({ channel, source }) => ({ ...channel, source }));
    return NextResponse.json({ channels });
  } catch (error) {
    return answerAlertError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/channels";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await saveChannel(body, { username: gate.session.username, admin: true });
    emitAuditEvent({
      type: "notification_channel",
      action: "saved",
      target: record.id,
      user: gate.session.username,
      result: "success",
      details: record.kind,
    });
    logger.info("Channel saved", { route, channelId: record.id, kind: record.kind, user: gate.session.username });
    return NextResponse.json({ channel: { ...record, source: "store" } }, { status: 201 });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
