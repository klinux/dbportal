import { NextResponse } from "next/server";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { listSlackChannels, slackConfigured } from "@/lib/notify/slack";

/**
 * The Slack channels the bot can see, by name (docs/CONTEXT.md §4.29), so a person picks one
 * instead of typing its id. 503 without the bot token; 502 when Slack refuses (the reason
 * stays in the server log - the bot may lack the channels:read scope).
 */
export async function GET(request: Request) {
  const route = "GET /api/channels/slack";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  if (!slackConfigured()) {
    return NextResponse.json({ error: "Slack is not configured on the server (SLACK_BOT_TOKEN)" }, { status: 503 });
  }
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ channels: await listSlackChannels(query.slice(0, 80)) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Slack answered")) {
      return NextResponse.json({ error: "Slack refused the channel list; see the server log" }, { status: 502 });
    }
    return answerAlertError(error, route);
  }
}
