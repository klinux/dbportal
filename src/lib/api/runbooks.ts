import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { RunbookError } from "@/lib/runbooks/store";
import { logger } from "@/lib/logger";

/** The store's own refusals answered with their status; anything else through the shared mapper. */
export function answerRunbookError(error: unknown, route: string): NextResponse {
  if (error instanceof RunbookError) {
    logger.warn("Runbook request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}

/** The runbook id a query request may name for its audit line (§4.20); anything else is absent. */
export function readRunbookId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : undefined;
}
