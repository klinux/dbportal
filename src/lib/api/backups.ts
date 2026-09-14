import { NextResponse } from "next/server";
import { BackupError } from "@/lib/backups/errors";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/** A backup refusal answered with its status; anything else through the shared mapper. */
export function answerBackupError(error: unknown, route: string): NextResponse {
  if (error instanceof BackupError) {
    logger.warn("Backup request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
