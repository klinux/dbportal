import { NextResponse } from "next/server";
import { canExport, isReadStatement } from "@/lib/access";
import { readBoundParams } from "@/lib/api/bound-params";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { statementTooLarge } from "@/lib/api/statement-size";
import { emitAuditEvent } from "@/lib/audit";
import { auditExecution } from "@/lib/audit-execution";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { buildResultExport, type ResultExportFormat } from "@/lib/export/result-export";
import type { CsvDelimiter } from "@/lib/export/csv";
import { capPrepareOptions, withConcurrency } from "@/lib/limits";
import { maskResult } from "@/lib/masking/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * A result as a file, built here (docs/CONTEXT.md §4.22): the statement runs again on the
 * server, the rows leave masked exactly as the grid gets them, the file is written by the
 * same writers the studio used to run in the browser, and two lines go on the trail - the
 * execution, and a `data_export` naming who took how many rows of which datasource in
 * which form. Before any of it, the datasource's export rule: `exportRoles`, or the
 * environment's default (nothing leaves production until somebody is named).
 *
 * Only a statement that reads: a file of an UPDATE's result is not a thing, and the read
 * is what the rule is about.
 */
const FORMATS = new Set<string>(["csv", "json", "sql-insert", "sql-ddl"]);
const DELIMITERS = new Set<string>([",", ";", "\t"]);
/** How many rows one file may hold when the datasource sets no cap of its own. */
export const EXPORT_MAX_ROWS = 100_000;
const BOM = "\ufeff";

export async function POST(req: Request) {
  const route = "POST /api/db/export";
  const guard = await guardRoute({ route, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await req.json();
    const { sql } = body;
    const format =
      typeof body.format === "string" && FORMATS.has(body.format) ? (body.format as ResultExportFormat) : null;
    const csvDelimiter =
      typeof body.csvDelimiter === "string" && DELIMITERS.has(body.csvDelimiter)
        ? (body.csvDelimiter as CsvDelimiter)
        : undefined;
    if (typeof sql !== "string" || sql.trim().length === 0 || format === null) {
      return NextResponse.json(
        { error: "sql and format (csv, json, sql-insert, sql-ddl) are required" },
        { status: 400 },
      );
    }
    const tooLarge = statementTooLarge(sql);
    if (tooLarge) return tooLarge;
    const bound = readBoundParams(body.params);
    if (!bound.valid) return NextResponse.json({ error: bound.message }, { status: 400 });

    const connection = await resolveConnection(body, guard.session);
    if (!canExport(connection, guard.session)) {
      auditRoleDenial({ route, user: guard.session.username, request: req, reason: "export_not_allowed" });
      return NextResponse.json(
        { error: `Exports are not allowed for you on "${connection.name}"`, statusCode: 403 },
        { status: 403 },
      );
    }
    if (!isReadStatement(sql, connection.type)) {
      return NextResponse.json({ error: "Only a statement that reads can be exported" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(guard.session.username),
      readOnly: true,
    });
    const prepared = provider.prepareQuery(sql, capPrepareOptions({ limit: EXPORT_MAX_ROWS }, connection.limits));
    const ip = clientAddress(req);
    const result = await withConcurrency(connection, guard.session.username, () =>
      auditExecution(
        {
          route,
          action: "export",
          user: guard.session.username,
          connectionName: connection.name,
          statement: prepared.query,
          ip,
        },
        () => provider.query(prepared.query, bound.params),
      ),
    );
    const served = await maskResult(result, {
      session: guard.session,
      connectionName: connection.name,
      reveal: body.reveal === true,
    });
    const file = buildResultExport(format, {
      rows: served.rows,
      fields: served.fields,
      tabName: typeof body.tabName === "string" && body.tabName.trim() ? body.tabName.trim().slice(0, 64) : "result",
      dialect: connection.type,
      columnTypes: result.columnTypes,
      csvDelimiter,
    });
    emitAuditEvent({
      type: "data_export",
      action: format,
      target: route,
      user: guard.session.username,
      result: "success",
      connectionName: connection.name,
      details: `${served.rows.length} rows${prepared.wasLimited && served.rows.length === prepared.limit ? " (cut at the cap)" : ""}`,
      rows: served.rows.length,
      ip,
    });
    const content = file.mimeType.startsWith("text/csv") ? `${BOM}${file.content}` : file.content;
    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="export.${file.extension}"`,
        "X-Export-Rows": String(served.rows.length),
        "X-Export-Extension": file.extension,
      },
    });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
