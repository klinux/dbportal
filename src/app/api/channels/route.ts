import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { listChannels, saveChannel, summarize } from "@/lib/channels/store";
import { logger } from "@/lib/logger";

/**
 * The channels an alert may name (docs/CONTEXT.md §4.29): id, name, kind and who declared
 * each, for anyone signed in - never the target; and a declaration by anyone signed in, a
 * webhook host being one an administrator allowed unless the person administers.
 */
export async function GET(request: Request) {
  const route = "GET /api/channels";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    return NextResponse.json({ channels: (await listChannels()).map(({ channel }) => summarize(channel)) });
  } catch (error) {
    return answerAlertError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/channels";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await saveChannel(body, { username: guard.session.username, admin: guard.session.role === "admin" });
    emitAuditEvent({
      type: "notification_channel",
      action: "saved",
      target: record.id,
      user: guard.session.username,
      result: "success",
      details: record.kind,
    });
    logger.info("Channel saved", { route, channelId: record.id, kind: record.kind, user: guard.session.username });
    return NextResponse.json({ channel: summarize(record) }, { status: 201 });
  } catch (error) {
    return answerAlertError(error, route);
  }
}
