import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { getServerMaskingConfig, saveServerMaskingConfig } from "@/lib/masking/store";

/** The one shared masking configuration (docs/CONTEXT.md §4.7): read and replaced by administrators. */
export async function GET(request: Request) {
  const gate = await requireAdmin("GET /api/admin/masking", request);
  if ("response" in gate) return gate.response;
  return NextResponse.json({ config: await getServerMaskingConfig() });
}

export async function PUT(request: Request) {
  const route = "PUT /api/admin/masking";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const config = await saveServerMaskingConfig(body, gate.session.username);
    emitAuditEvent({
      type: "masking_config",
      action: "updated",
      target: "masking",
      user: gate.session.username,
      result: "success",
    });
    return NextResponse.json({ config });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
