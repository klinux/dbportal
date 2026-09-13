import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * A write that entered "awaiting approval" instead of running (docs/CONTEXT.md §4.6). Kept
 * apart from the store so the shared error mapper can answer it without importing the
 * store's dependencies. Carries the request so the client can show and watch it.
 */
export class ApprovalRequiredError extends Error {
  constructor(public readonly approval: ApprovalRequest) {
    super(`A write on "${approval.datasourceName}" needs approval; request ${approval.id} is awaiting a reviewer`);
    this.name = "ApprovalRequiredError";
  }
}

/** A refusal of the approvals API itself: not found, not pending, one's own request, no store. */
export class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}
