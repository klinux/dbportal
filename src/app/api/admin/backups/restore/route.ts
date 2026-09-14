import { NextResponse } from "next/server";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerBackupError } from "@/lib/api/backups";
import { restoreBackup } from "@/lib/backups/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/** Restore one of a datasource's own backups over it (docs/CONTEXT.md §4.14); refused on production. */
export async function POST(request: Request) {
  const route = "POST /api/admin/backups/restore";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    const datasourceId = typeof body?.datasourceId === "string" ? body.datasourceId.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!datasourceId || !name)
      return NextResponse.json({ error: "datasourceId and name are required" }, { status: 400 });
    const connection = await resolveConnection({ connectionId: `seed:${datasourceId}` }, gate.session);
    const backup = await restoreBackup(connection, name, gate.session.username);
    return NextResponse.json({ restored: backup });
  } catch (error) {
    return answerBackupError(error, route);
  }
}
