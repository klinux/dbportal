import { NextResponse } from "next/server";
import { guardServiceRoute } from "@/lib/api/service-auth";
import { answerApprovalError } from "@/lib/api/approvals";
import { createErrorResponse } from "@/lib/api/errors";
import { getExecutionForToken } from "@/lib/executions/store";

type Params = { params: Promise<{ id: string }> };

/** One execution the calling token queued: its status and, once it ran, its bounded outcome. */
export async function GET(request: Request, { params }: Params) {
  const route = "GET /api/v1/executions/[id]";
  const guard = await guardServiceRoute({ route, request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const record = await getExecutionForToken(id, guard.identity);
    if (!record) return NextResponse.json({ error: "Execution not found" }, { status: 404 });
    return NextResponse.json({ execution: record });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}
