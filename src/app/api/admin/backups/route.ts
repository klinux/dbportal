import { NextResponse } from "next/server";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerBackupError, answerBackupJob } from "@/lib/api/backups";
import { BACKUP_WAIT_MS, enqueueBackup, openBackupJob } from "@/lib/backups/job";
import { backupSupported, gcsBucket, listBackups, restoreAllowed, toolAvailable } from "@/lib/backups/store";
import { waitForJob } from "@/lib/jobs/queue";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * Backups of one datasource (docs/CONTEXT.md §4.14, §4.40), admin only. GET answers what
 * the page needs to draw itself: whether the engine and this server can take one, whether
 * a restore is offered (never on production), whether a bucket receives the copy, the
 * files so far, and the job a worker still has, if any. POST hands one to the queue and
 * waits a while for the file; past the wait it answers 202 with the job to poll.
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
      job: supported ? await openBackupJob(datasourceId) : null,
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
    const job = await enqueueBackup(connection, "create", gate.session);
    return answerBackupJob((await waitForJob(job.id, BACKUP_WAIT_MS)) ?? job, true);
  } catch (error) {
    return answerBackupError(error, route);
  }
}
