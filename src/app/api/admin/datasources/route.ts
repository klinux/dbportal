import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getConfigSeedIds } from "@/lib/seed";
import { loadConfig } from "@/lib/seed/config-loader";
import {
  createSharedDatasource,
  isSharedStoreAvailable,
  listSharedDatasources,
  toSharedDatasourceView,
} from "@/lib/datasources/store";
import { answerSharedDatasourceError, readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";

/**
 * The store's records, secrets redacted, plus what the seed YAML declares (read-only here,
 * marked by `source`) so the administrator sees every shared datasource in one list and
 * knows which ones are edited in version control rather than on this page.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const route = "GET /api/admin/datasources";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;

  try {
    const [records, config] = await Promise.all([listSharedDatasources(), loadConfig()]);
    const datasources = records.map((record) => ({ ...toSharedDatasourceView(record), source: "store" as const }));
    const declared = (config?.connections ?? []).map((conn) => ({
      id: conn.id,
      name: conn.name,
      type: conn.type,
      environment: conn.environment ?? config?.defaults?.environment,
      group: conn.group,
      roles: conn.roles,
      source: "config" as const,
    }));
    return NextResponse.json({ available: isSharedStoreAvailable(), datasources, declared });
  } catch (error) {
    return answerSharedDatasourceError(error, route);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const route = "POST /api/admin/datasources";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;

  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });

    // The YAML owns its ids: a runtime record with the same id would be shadowed by it in
    // every list (src/lib/seed/index.ts), which is a datasource that exists and cannot be seen.
    if (typeof body.id === "string" && (await getConfigSeedIds()).has(body.id)) {
      return NextResponse.json(
        { error: `Datasource id "${body.id}" is declared in the seed configuration; edit it there`, statusCode: 409 },
        { status: 409 },
      );
    }

    const record = await createSharedDatasource(body, gate.session.username);
    emitAuditEvent({
      type: "managed_connection",
      action: "created",
      target: record.id,
      connectionName: record.name,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Shared datasource created", { route, connectionId: record.id, user: gate.session.username });
    return NextResponse.json({ datasource: toSharedDatasourceView(record) }, { status: 201 });
  } catch (error) {
    return answerSharedDatasourceError(error, route);
  }
}
