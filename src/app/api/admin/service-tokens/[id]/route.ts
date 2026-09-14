import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerServiceTokenError } from "@/lib/api/service-tokens";
import { revokeServiceToken, toServiceTokenView } from "@/lib/service-tokens/store";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/** Revoke: the secret stops working at once; the record stays so the audit trail still names it. */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/service-tokens/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await revokeServiceToken(id, gate.session.username);
    emitAuditEvent({
      type: "service_token",
      action: "revoked",
      target: record.name,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Service token revoked", { route, tokenId: record.id, user: gate.session.username });
    return NextResponse.json({ token: toServiceTokenView(record) });
  } catch (error) {
    return answerServiceTokenError(error, route);
  }
}
