import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { NamedRoleError } from "@/lib/roles/store";
import { logger } from "@/lib/logger";

/** The store's own refusals answered with their status; anything else through the shared mapper. */
export function answerNamedRoleError(error: unknown, route: string): NextResponse {
  if (error instanceof NamedRoleError) {
    logger.warn("Named role request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
