import { NextResponse } from "next/server";
import { AlertError } from "@/lib/alerts/store";
import { createErrorResponse } from "@/lib/api/errors";
import { ChannelError } from "@/lib/channels/store";
import { logger } from "@/lib/logger";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";

/** The stores' own refusals answered with their status; anything else through the shared mapper. */
export function answerAlertError(error: unknown, route: string): NextResponse {
  if (error instanceof AlertError || error instanceof ChannelError || error instanceof SeedConnectionError) {
    logger.warn("Alert request refused", { route, statusCode: error.statusCode });
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}
