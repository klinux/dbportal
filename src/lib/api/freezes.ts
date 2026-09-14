import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { FreezeError } from "@/lib/freezes/store";
import { logger } from "@/lib/logger";

/** The store's own refusals answered with their status; anything else through the shared mapper. */
export function answerFreezeError(error: unknown, route: string): NextResponse {
  if (error instanceof FreezeError) {
    logger.warn("Freeze window request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
