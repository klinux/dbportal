import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { SeedDataError } from "@/lib/seed-data/errors";
import { logger } from "@/lib/logger";

/** The feature's own refusals answered with their status; anything else through the shared mapper. */
export function answerSeedDataError(error: unknown, route: string): NextResponse {
  if (error instanceof SeedDataError) {
    logger.warn("Seed request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
