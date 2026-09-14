import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { ServiceTokenError } from "@/lib/service-tokens/store";

/** The store's own refusals answered with their status; anything else through the shared mapper. */
export function answerServiceTokenError(error: unknown, route: string): NextResponse {
  if (error instanceof ServiceTokenError) {
    logger.warn("Service token request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
