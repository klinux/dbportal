import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * A result leaving the portal as a file (docs/CONTEXT.md §4.22, first half): the browser
 * builds the file from the rows it holds, and tells the server here so the export is on the
 * audit trail - who, which datasource, which form, how many rows. The datasource is resolved
 * the way every route resolves it, so the line names what the session may open and nothing
 * the caller made up. The rule that decides whether an export is allowed at all is the
 * second half of §4.22; this is the record.
 */
const FORMATS = new Set(["csv", "json", "sql-insert", "sql-ddl"]);

export async function POST(request: Request) {
  const route = "POST /api/audit/export";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const format = typeof body?.format === "string" && FORMATS.has(body.format) ? body.format : null;
    const rows = typeof body?.rows === "number" && Number.isInteger(body.rows) && body.rows >= 0 ? body.rows : null;
    if (!body || format === null || rows === null) {
      return NextResponse.json(
        { error: "format (csv, json, sql-insert, sql-ddl) and rows are required" },
        { status: 400 },
      );
    }
    const connection = await resolveConnection(body, guard.session);
    emitAuditEvent({
      type: "data_export",
      action: format,
      target: route,
      user: guard.session.username,
      result: "success",
      connectionName: connection.name,
      details: `${rows} rows`,
      rows,
      ip: clientAddress(request),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
