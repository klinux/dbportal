import { NextResponse } from "next/server";
import { guardRoute } from "@/lib/api/require-session";
import { createErrorResponse } from "@/lib/api/errors";
import { answerApprovalError } from "@/lib/api/approvals";
import { listForReviewer, listMine } from "@/lib/approvals/store";

/**
 * Write approval requests (docs/CONTEXT.md §4.6). `?scope=mine` lists the caller's own;
 * anything else lists what the caller may review - pending first - which is empty for a
 * session that reviews nothing, never a 403: the list is the answer.
 */
export async function GET(request: Request) {
  const route = "GET /api/approvals";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const scope = new URL(request.url).searchParams.get("scope");
    const approvals = scope === "mine" ? await listMine(guard.session.username) : await listForReviewer(guard.session);
    return NextResponse.json({ approvals });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}
