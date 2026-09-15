import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerBackupError, answerBackupJob } from "@/lib/api/backups";
import { isBackupJob } from "@/lib/backups/job";
import { getJob } from "@/lib/jobs/queue";

type Params = { params: Promise<{ jobId: string }> };

/** A backup or restore that outran the route's wait (docs/CONTEXT.md §4.40): 202 while a worker has it, then its outcome. */
export async function GET(request: Request, { params }: Params) {
  const route = "GET /api/admin/backups/[jobId]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { jobId } = await params;
    const job = await getJob(jobId);
    if (!isBackupJob(job)) {
      return NextResponse.json({ error: `Backup job "${jobId}" not found`, statusCode: 404 }, { status: 404 });
    }
    return answerBackupJob(job);
  } catch (error) {
    return answerBackupError(error, route);
  }
}
