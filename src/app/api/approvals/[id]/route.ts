import { NextResponse } from "next/server";
import { guardRoute } from "@/lib/api/require-session";
import { createErrorResponse } from "@/lib/api/errors";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { answerApprovalError, readDecision } from "@/lib/api/approvals";
import { canReview, decideApproval, getApproval } from "@/lib/approvals/store";
import { settleDecision } from "@/lib/executions/store";

type Params = { params: Promise<{ id: string }> };

/** One request, for its requester or a reviewer of its datasource; anyone else sees 404. */
export async function GET(request: Request, { params }: Params) {
  const route = "GET /api/approvals/[id]";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const record = await getApproval(id);
    if (!record || (record.requester !== guard.session.username && !(await canReview(record, guard.session)))) {
      return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
    }
    return NextResponse.json({ approval: record });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}

/** A reviewer's decision: `{ decision: "approve" | "reject", windowMinutes?, note? }`. */
export async function POST(request: Request, { params }: Params) {
  const route = "POST /api/approvals/[id]";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const record = await getApproval(id);
    if (!record) return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
    if (!(await canReview(record, guard.session))) {
      auditRoleDenial({ route, user: guard.session.username, request });
      return NextResponse.json({ error: "You may not review requests on this datasource" }, { status: 403 });
    }
    const decision = await readDecision(request);
    if (!decision.valid) return NextResponse.json({ error: decision.message }, { status: 400 });
    const decided = await decideApproval({
      id,
      reviewer: guard.session.username,
      decision: decision.decision,
      windowMinutes: decision.windowMinutes,
      note: decision.note,
    });
    // An execution request (§4.10) runs, or is answered, as part of the decision.
    return NextResponse.json({ approval: await settleDecision(decided) });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}
