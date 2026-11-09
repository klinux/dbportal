import { NextResponse } from "next/server";
import { guardServiceRoute } from "@/lib/api/service-auth";
import { answerApprovalError } from "@/lib/api/approvals";
import { createErrorResponse } from "@/lib/api/errors";
import { decideExecutionForToken } from "@/lib/executions/store";

type Params = { params: Promise<{ id: string }> };

/**
 * A reviewer's decision on a pending execution, relayed by the token that queued it
 * (docs/CONTEXT.md §4.10): `{ decision: "approve" | "reject", reviewer, note? }`. The token
 * needs `trustedReviews`, and `reviewer` must pass the datasource's `approverRoles` — the
 * refusals name which condition failed. Approved, the statement runs at once, exactly as a
 * decision on the page would; the answer is the record as the decision left it.
 */
export async function POST(request: Request, { params }: Params) {
  const route = "POST /api/v1/executions/[id]/decision";
  const guard = await guardServiceRoute({ route, request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "The body must be JSON" }, { status: 400 });
    }
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const decided = await decideExecutionForToken(id, guard.identity, input);
    return NextResponse.json({ execution: decided });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}
