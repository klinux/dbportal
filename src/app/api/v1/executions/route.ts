import { NextResponse } from "next/server";
import { guardServiceRoute } from "@/lib/api/service-auth";
import { answerApprovalError } from "@/lib/api/approvals";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { submitExecution } from "@/lib/executions/store";

/**
 * A bot's execution request (docs/CONTEXT.md §4.10):
 * `{ datasourceId, statement, onBehalfOf, reply?: { channel, threadTs? } }`.
 * 200 with the outcome when policy let it run at once; 202 with the pending record when a
 * reviewer must decide first. The record is what `GET /api/v1/executions/[id]` returns.
 */
export async function POST(request: Request) {
  const route = "POST /api/v1/executions";
  const guard = await guardServiceRoute({ route, request });
  if ("response" in guard) return guard.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await submitExecution(
      { datasourceId: body.datasourceId, statement: body.statement, onBehalfOf: body.onBehalfOf, reply: body.reply },
      guard.identity,
    );
    return NextResponse.json({ execution: record }, { status: record.status === "pending" ? 202 : 200 });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}
