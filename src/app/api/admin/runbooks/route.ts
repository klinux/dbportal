import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerRunbookError } from "@/lib/api/runbooks";
import { createRunbook, listRunbooks } from "@/lib/runbooks/store";
import { logger } from "@/lib/logger";

/** Runbooks (docs/CONTEXT.md §4.20): list them with their source; declare one. Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/runbooks";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const runbooks = (await listRunbooks()).map(({ runbook, source }) => ({ ...runbook, source }));
    return NextResponse.json({ runbooks });
  } catch (error) {
    return answerRunbookError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/runbooks";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await createRunbook(body, gate.session.username);
    emitAuditEvent({
      type: "runbook",
      action: "created",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Runbook created", { route, runbookId: record.id, user: gate.session.username });
    return NextResponse.json({ runbook: { ...record, source: "store" } }, { status: 201 });
  } catch (error) {
    return answerRunbookError(error, route);
  }
}
