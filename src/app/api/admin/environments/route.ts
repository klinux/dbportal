import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerEnvironmentError } from "@/lib/api/environments";
import { listEnvironments, saveEnvironment } from "@/lib/environments/store";
import { logger } from "@/lib/logger";

/** Environments (docs/CONTEXT.md §4.36): list them with their source; declare or redefine one. Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/environments";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const environments = (await listEnvironments()).map(({ environment, source }) => ({ ...environment, source }));
    return NextResponse.json({ environments });
  } catch (error) {
    return answerEnvironmentError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/environments";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await saveEnvironment(body, gate.session.username);
    emitAuditEvent({
      type: "environment",
      action: "saved",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Environment saved", { route, environmentId: record.id, user: gate.session.username });
    return NextResponse.json({ environment: { ...record, source: "store" } }, { status: 201 });
  } catch (error) {
    return answerEnvironmentError(error, route);
  }
}
