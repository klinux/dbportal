import { NextResponse } from "next/server";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerBackupError } from "@/lib/api/backups";
import {
  backupSupported,
  createBackup,
  gcsBucket,
  listBackups,
  restoreAllowed,
  toolAvailable,
} from "@/lib/backups/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * Backups of one datasource (docs/CONTEXT.md §4.14), admin only. GET answers what the page
 * needs to draw itself: whether the engine and this server can take one, whether a restore
 * is offered (never on production), whether a bucket receives the copy, and the files so
 * far. POST takes one now.
 */
function datasourceIdOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function GET(request: Request) {
  const route = "GET /api/admin/backups";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const datasourceId = datasourceIdOf(new URL(request.url).searchParams.get("datasourceId"));
    if (!datasourceId) return NextResponse.json({ error: "datasourceId is required" }, { status: 400 });
    const connection = await resolveConnection({ connectionId: `seed:${datasourceId}` }, gate.session);
    const supported = backupSupported(connection.type);
    return NextResponse.json({
      supported,
      tool: supported ? await toolAvailable() : false,
      restoreAllowed: restoreAllowed(connection),
      bucket: gcsBucket() !== null,
      backups: supported ? await listBackups(datasourceId) : [],
    });
  } catch (error) {
    return answerBackupError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/backups";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    const datasourceId = datasourceIdOf(body?.datasourceId);
    if (!datasourceId) return NextResponse.json({ error: "datasourceId is required" }, { status: 400 });
    const connection = await resolveConnection({ connectionId: `seed:${datasourceId}` }, gate.session);
    const backup = await createBackup(connection, gate.session.username);
    return NextResponse.json({ backup }, { status: 201 });
  } catch (error) {
    return answerBackupError(error, route);
  }
}
