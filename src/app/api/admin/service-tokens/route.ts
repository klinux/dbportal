import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerServiceTokenError } from "@/lib/api/service-tokens";
import { createServiceToken, listServiceTokens, toServiceTokenView } from "@/lib/service-tokens/store";
import { logger } from "@/lib/logger";

/** Service tokens (docs/CONTEXT.md §4.10): list without hashes; create and receive the secret once. */
export async function GET(request: Request) {
  const route = "GET /api/admin/service-tokens";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json({ tokens: await listServiceTokens() });
  } catch (error) {
    return answerServiceTokenError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/service-tokens";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const { record, secret } = await createServiceToken(body, gate.session.username);
    emitAuditEvent({
      type: "service_token",
      action: "created",
      target: record.name,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Service token created", { route, tokenId: record.id, user: gate.session.username });
    return NextResponse.json({ token: toServiceTokenView(record), secret }, { status: 201 });
  } catch (error) {
    return answerServiceTokenError(error, route);
  }
}
