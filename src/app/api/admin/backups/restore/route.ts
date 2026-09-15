import { NextResponse } from "next/server";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerBackupError, answerBackupJob } from "@/lib/api/backups";
import { BACKUP_WAIT_MS, enqueueBackup } from "@/lib/backups/job";
import { waitForJob } from "@/lib/jobs/queue";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/** Restore one of a datasource's own backups over it (docs/CONTEXT.md §4.14, §4.40) through the queue; refused on production. */
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
    const job = await enqueueBackup(connection, "restore", gate.session, name);
    return answerBackupJob((await waitForJob(job.id, BACKUP_WAIT_MS)) ?? job);
  } catch (error) {
    return answerBackupError(error, route);
  }
}
