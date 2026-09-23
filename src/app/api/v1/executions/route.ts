import { NextResponse } from "next/server";
import { guardServiceRoute } from "@/lib/api/service-auth";
import { answerApprovalError } from "@/lib/api/approvals";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { submitExecution } from "@/lib/executions/store";

/**
 * A bot's execution request (docs/CONTEXT.md §4.10):
 * `{ datasourceId, statement, onBehalfOf, reply?: { channel, threadTs? } }`.
 * 202 with the record while it waits - for a reviewer, or for the worker that runs it
 * (§4.40); 200 with the outcome inside once it ran. `GET /api/v1/executions/[id]` is the
 * same record, to poll.
 */
export async function POST(request: Request) {
  const route = "POST /api/v1/executions";
  const guard = await guardServiceRoute({ route, request });
  if ("response" in guard) return guard.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await submitExecution(
      {
        datasourceId: body.datasourceId,
        statement: body.statement,
        onBehalfOf: body.onBehalfOf,
        reply: body.reply,
        ticket: body.ticket,
        review: body.review,
        callback: body.callback,
        approvedBy: body.approvedBy,
      },
      guard.identity,
    );
    // 202 until the outcome is there: a request may wait for a reviewer, or for a worker (§4.40).
    return NextResponse.json({ execution: record }, { status: record.execution ? 200 : 202 });
  } catch (error) {
    return answerApprovalError(error, route) ?? createErrorResponse(error, { route });
  }
}
