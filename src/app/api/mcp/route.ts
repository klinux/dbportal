import { NextResponse } from "next/server";
import { guardServiceRoute } from "@/lib/api/service-auth";
import { handleMcpMessage, parseError } from "@/lib/mcp/server";
import { version } from "../../../../package.json";

/**
 * The MCP endpoint (docs/CONTEXT.md §4.30): one POST per JSON-RPC message, a service token
 * as the Bearer, no session and no stream. A GET is what a client opens for server-sent
 * events; this server has none to send, and says so with a 405 rather than holding a
 * connection open.
 */
export async function POST(request: Request) {
  const route = "POST /api/mcp";
  const guard = await guardServiceRoute({ route, request });
  if ("response" in guard) return guard.response;
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    const parse = parseError();
    return NextResponse.json(parse.body, { status: parse.status });
  }
  const answer = await handleMcpMessage(message, guard.identity, version);
  if (answer.body === null) return new NextResponse(null, { status: answer.status });
  return NextResponse.json(answer.body, { status: answer.status });
}

export async function GET() {
  return NextResponse.json(
    { error: "This MCP server answers each POST whole and opens no event stream" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
