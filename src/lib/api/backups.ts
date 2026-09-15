import { NextResponse } from "next/server";
import { backupOutcome } from "@/lib/backups/job";
import { BackupError } from "@/lib/backups/errors";
import { createErrorResponse } from "@/lib/api/errors";
import { JobError } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import type { JobRecord } from "@/lib/storage/types";

/** A backup refusal, or the queue's, answered with its status; anything else through the shared mapper. */
export function answerBackupError(error: unknown, route: string): NextResponse {
  if (error instanceof BackupError || error instanceof JobError) {
    logger.warn("Backup request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}

/**
 * A backup job as the routes answer it (docs/CONTEXT.md §4.40): 202 while a worker has it,
 * `created` when a backup is done (201 the first time, 200 read back), the failure's word
 * with 502 when the tool failed and 500 when the worker vanished.
 */
export function answerBackupJob(job: JobRecord, fresh = false): NextResponse {
  const outcome = backupOutcome(job);
  if (outcome.status === "queued" || outcome.status === "running") {
    return NextResponse.json(outcome, { status: 202 });
  }
  if (outcome.status === "done") {
    return NextResponse.json(outcome, { status: fresh && outcome.action === "create" ? 201 : 200 });
  }
  const statusCode = outcome.status === "failed" ? 502 : 500;
  return NextResponse.json({ ...outcome, error: outcome.error, statusCode }, { status: statusCode });
}
