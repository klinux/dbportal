import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerFreezeError } from "@/lib/api/freezes";
import { createFreezeWindow, listFreezeWindows } from "@/lib/freezes/store";
import { logger } from "@/lib/logger";

/** Freeze windows (docs/CONTEXT.md §4.17): list them with their source; declare one. Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/freezes";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const windows = (await listFreezeWindows()).map(({ window, source }) => ({ ...window, source }));
    return NextResponse.json({ windows });
  } catch (error) {
    return answerFreezeError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/freezes";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await createFreezeWindow(body, gate.session.username);
    emitAuditEvent({
      type: "freeze_window",
      action: "created",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Freeze window created", { route, freezeId: record.id, user: gate.session.username });
    return NextResponse.json({ window: { ...record, source: "store" } }, { status: 201 });
  } catch (error) {
    return answerFreezeError(error, route);
  }
}
