import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { JobError } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";

/** The queue's own refusals answered with their status; anything else through the shared mapper. */
export function answerJobError(error: unknown, route: string): NextResponse {
  if (error instanceof JobError) {
    logger.warn("Job request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
