import { NextResponse } from "next/server";
import { answerAlertError } from "@/lib/api/alerts";
import { guardRoute } from "@/lib/api/require-session";
import { listChannels, summarize } from "@/lib/channels/store";

/** The channels an alert may name (docs/CONTEXT.md §4.29): id, name and kind, for anyone signed in; never the target. */
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
