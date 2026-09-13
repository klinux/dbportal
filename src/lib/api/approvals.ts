import { NextResponse } from "next/server";
import { ApprovalError } from "@/lib/approvals/errors";
import { logger } from "@/lib/logger";
import type { ApprovalDecision } from "@/lib/storage/types";

/**
 * What the approvals routes share (docs/CONTEXT.md §4.6): the store's own refusals answered
 * with their status, and the reviewer's body read into a decision. A lib module because a
 * Next.js route file may export nothing but its handlers.
 */
export function answerApprovalError(error: unknown, route: string): NextResponse | null {
  if (!(error instanceof ApprovalError)) return null;
  logger.warn("Approval request refused", { route, statusCode: error.statusCode });
  return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
}

export type DecisionBody =
  | { valid: true; decision: ApprovalDecision; windowMinutes?: unknown; note?: unknown }
  | { valid: false; message: string };

export async function readDecision(request: Request): Promise<DecisionBody> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { valid: false, message: "Request body must be a JSON object" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, message: "Request body must be a JSON object" };
  }
  const { decision, windowMinutes, note } = body as Record<string, unknown>;
  if (decision !== "approve" && decision !== "reject") {
    return { valid: false, message: 'decision must be "approve" or "reject"' };
  }
  return { valid: true, decision, windowMinutes, note };
}
