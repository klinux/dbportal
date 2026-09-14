import { randomUUID } from "node:crypto";
import { emitAuditEvent } from "@/lib/audit";
import { canApprove, type AccessSession } from "@/lib/access";
import { logger } from "@/lib/logger";
import { getSeedConnectionByIdUnfiltered } from "@/lib/seed";
import { getStorageProvider } from "@/lib/storage/factory";
import type { Guardrail } from "@/lib/guardrails";
import type { ApprovalDecision, ApprovalRequest } from "@/lib/storage/types";
import { ApprovalError, ApprovalRequiredError } from "./errors";

/**
 * Write approval (docs/CONTEXT.md §4.6). A datasource declared `writeApproval: true` runs a
 * writing statement only inside an open WRITE WINDOW: an approval a reviewer granted to
 * this person, for this datasource, until a time the reviewer chose. Without one, the
 * attempt becomes a pending request (one per person and datasource) and the statement does
 * not run; the person runs it again once approved.
 *
 * Why a window and not "execute on approval": the reviewer approves a person's access for
 * a bounded time, and the person, who is present, runs and sees the result - the server
 * never executes a stored statement on someone's behalf later. The statement travels with
 * the request so the reviewer sees what prompted it.
 *
 * Records live in the server store (`approval_requests`); without one, approval-gated
 * writes are refused with a 503 that says what to configure.
 */
export const DEFAULT_WINDOW_MINUTES = 15;
export const MAX_WINDOW_MINUTES = 240;
/**
 * What a request keeps of its statement, and what the bot API takes (docs/CONTEXT.md
 * §4.21): an `UPDATE … WHERE id IN (…)` of two thousand ids is about twenty thousand
 * characters, so the bound sits well above that; the reviewer's page folds a long one.
 */
export const STATEMENT_MAX_CHARS = 32_000;
export const NOTE_MAX_CHARS = 500;
const RECENT_LIMIT = 200;

/** How long a request waits for a reviewer before it expires (docs/CONTEXT.md §4.28). */
export function approvalTtlMs(): number {
  const hours = Number(process.env.APPROVAL_TTL_HOURS);
  const bounded = Number.isFinite(hours) && hours > 0 ? Math.min(720, Math.max(1, hours)) : 24;
  return bounded * 3_600_000;
}

function expiredCopy(record: ApprovalRequest, now: number): ApprovalRequest | null {
  if (record.status !== "pending") return null;
  if (Date.parse(record.requestedAt) + approvalTtlMs() > now) return null;
  return { ...record, status: "expired", reviewedAt: new Date(now).toISOString() };
}

/**
 * The records as they are now: a pending one past its time is expired, written back and
 * audited, so every reader - the page, the tab's poll, the bot, the gate - sees the same
 * thing without a scheduler.
 */
async function settleExpiry(
  store: { putApproval(record: ApprovalRequest): Promise<void> },
  records: ApprovalRequest[],
  now = Date.now(),
): Promise<ApprovalRequest[]> {
  const out: ApprovalRequest[] = [];
  for (const record of records) {
    const expired = expiredCopy(record, now);
    if (!expired) {
      out.push(record);
      continue;
    }
    await store.putApproval(expired);
    try {
      emitAuditEvent({
        type: "approval_decision",
        action: "expired",
        target: record.datasourceId,
        connectionName: record.datasourceName,
        user: "system",
        result: "failure",
        approvalId: record.id,
      });
    } catch (auditError) {
      logger.error("Failed to record approval expiry audit event", auditError, { route: "approvals/store" });
    }
    out.push(expired);
  }
  return out;
}

const STORE_UNAVAILABLE = "Write approval needs server storage: set STORAGE_PROVIDER to sqlite or postgres";

async function requireStore() {
  const provider = await getStorageProvider();
  if (!provider) throw new ApprovalError(STORE_UNAVAILABLE, 503);
  return provider;
}

export function isWindowOpen(record: ApprovalRequest, now = Date.now()): boolean {
  return record.status === "approved" && record.windowUntil !== undefined && Date.parse(record.windowUntil) > now;
}

/** The approval that lets `requester` write on `datasourceId` right now, if any. */
export async function findOpenWindow(datasourceId: string, requester: string): Promise<ApprovalRequest | null> {
  const store = await requireStore();
  const approved = await store.listApprovals({ datasourceId, requester, status: "approved", limit: 20 });
  const now = Date.now();
  return approved.find((record) => isWindowOpen(record, now)) ?? null;
}

/**
 * The pending request for this person on this datasource - the existing one, or a new one
 * carrying the statement that was refused. One per pair: a person retrying does not pile
 * up requests for a reviewer to wade through.
 */
export async function requestApproval(input: {
  datasourceId: string;
  datasourceName: string;
  requester: string;
  statement: string;
  route: string;
  guardrail?: Guardrail;
  ticket?: string;
  approvalsRequired?: number;
}): Promise<ApprovalRequest> {
  const store = await requireStore();
  const [pending] = await settleExpiry(
    store,
    await store.listApprovals({
      datasourceId: input.datasourceId,
      requester: input.requester,
      status: "pending",
      limit: 1,
    }),
  );
  if (pending?.status === "pending") return pending;
  const record: ApprovalRequest = {
    id: randomUUID(),
    datasourceId: input.datasourceId,
    datasourceName: input.datasourceName,
    requester: input.requester,
    statement: input.statement.slice(0, STATEMENT_MAX_CHARS),
    route: input.route,
    status: "pending",
    requestedAt: new Date().toISOString(),
    ...(input.guardrail ? { guardrail: input.guardrail } : {}),
    ...(input.ticket ? { ticket: input.ticket } : {}),
    ...(input.approvalsRequired === 2 ? { approvalsRequired: 2 } : {}),
  };
  await store.putApproval(record);
  logger.info("Write approval requested", {
    route: input.route,
    approvalId: record.id,
    datasourceId: input.datasourceId,
    user: input.requester,
  });
  return record;
}

/**
 * The gate's own step, in one place: the open window for this person, or the pending
 * request the refused statement became - thrown, so the route answers it as a decision and
 * not as a result.
 */
export async function requireWriteWindow(input: {
  datasourceId: string;
  datasourceName: string;
  requester: string;
  statement: string;
  route: string;
  guardrail?: Guardrail;
  ticket?: string;
  approvalsRequired?: number;
}): Promise<ApprovalRequest> {
  const open = await findOpenWindow(input.datasourceId, input.requester);
  if (open) return open;
  throw new ApprovalRequiredError(await requestApproval(input));
}

/** Whether this session may review a request: the datasource's `approverRoles`, or admins. */
export async function canReview(record: ApprovalRequest, session: AccessSession): Promise<boolean> {
  const datasource = await getSeedConnectionByIdUnfiltered(record.datasourceId);
  return canApprove(datasource ?? {}, session);
}

export async function getApproval(id: string): Promise<ApprovalRequest | null> {
  const store = await requireStore();
  const record = await store.getApproval(id);
  if (!record) return null;
  const [settled] = await settleExpiry(store, [record]);
  return settled;
}

/** What a reviewer sees: pending first, then recent decisions, on datasources they may review. */
export async function listForReviewer(session: AccessSession): Promise<ApprovalRequest[]> {
  const store = await requireStore();
  const recent = await settleExpiry(store, await store.listApprovals({ limit: RECENT_LIMIT }));
  // One verdict per distinct datasource, shared by every record on it; the seed loader
  // caches the list, so this is one read per datasource, all in flight together.
  const verdicts = new Map<string, Promise<boolean>>();
  const allowed = await Promise.all(
    recent.map((record) => {
      let verdict = verdicts.get(record.datasourceId);
      if (!verdict) {
        verdict = canReview(record, session);
        verdicts.set(record.datasourceId, verdict);
      }
      return verdict;
    }),
  );
  return recent
    .filter((_, index) => allowed[index])
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
}

export async function listMine(requester: string): Promise<ApprovalRequest[]> {
  const store = await requireStore();
  return settleExpiry(store, await store.listApprovals({ requester, limit: 50 }));
}

function boundedWindowMinutes(value: unknown): number {
  if (value === undefined) return DEFAULT_WINDOW_MINUTES;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WINDOW_MINUTES) {
    throw new ApprovalError(`windowMinutes must be a whole number between 1 and ${MAX_WINDOW_MINUTES}`, 400);
  }
  return minutes;
}

/**
 * A reviewer's decision. Four eyes: nobody approves their own request, administrators
 * included. Every decision is an `approval_decision` audit event naming the reviewer, the
 * requester (as the connection's requester field is not an audit field, it rides in the
 * request the id points to) and the datasource.
 */
export async function decideApproval(input: {
  id: string;
  reviewer: string;
  decision: ApprovalDecision;
  windowMinutes?: unknown;
  note?: unknown;
}): Promise<ApprovalRequest> {
  const store = await requireStore();
  const found = await store.getApproval(input.id);
  if (!found) throw new ApprovalError(`Approval request "${input.id}" not found`, 404);
  const [record] = await settleExpiry(store, [found]);
  if (record.status !== "pending")
    throw new ApprovalError(`Approval request "${input.id}" is already ${record.status}`, 409);
  if (record.requester === input.reviewer) throw new ApprovalError("You cannot review your own request", 403);
  if (input.note !== undefined && typeof input.note !== "string") throw new ApprovalError("note must be a string", 400);
  // An execution request (§4.10) has no window: approving it runs the stored statement once.
  const isExecution = record.kind === "execution";
  const minutes = input.decision === "approve" && !isExecution ? boundedWindowMinutes(input.windowMinutes) : undefined;
  const reviewedAt = new Date();
  const note =
    typeof input.note === "string" && input.note.length > 0 ? { note: input.note.slice(0, NOTE_MAX_CHARS) } : {};
  // Two reviewers (§4.28): the first approval is kept on the record and it stays pending
  // for a second, distinct one; a rejection by either ends it.
  const needed = record.approvalsRequired ?? 1;
  const given = record.approvals ?? [];
  if (input.decision === "approve" && needed > 1) {
    if (given.some((a) => a.reviewer === input.reviewer)) {
      throw new ApprovalError("You have already approved this request; a second reviewer must", 409);
    }
    const approvals = [...given, { reviewer: input.reviewer, at: reviewedAt.toISOString() }];
    if (approvals.length < needed) {
      const waiting: ApprovalRequest = { ...record, approvals, ...note };
      await store.putApproval(waiting);
      auditDecision(record, input.reviewer, `approve ${approvals.length} of ${needed}`);
      return waiting;
    }
  }
  const decided: ApprovalRequest = {
    ...record,
    status: input.decision === "approve" ? "approved" : "rejected",
    reviewer: input.reviewer,
    reviewedAt: reviewedAt.toISOString(),
    ...(needed > 1 && input.decision === "approve"
      ? { approvals: [...given, { reviewer: input.reviewer, at: reviewedAt.toISOString() }] }
      : {}),
    ...(minutes !== undefined ? { windowUntil: new Date(reviewedAt.getTime() + minutes * 60_000).toISOString() } : {}),
    ...note,
  };
  await store.putApproval(decided);
  auditDecision(record, input.reviewer, input.decision);
  return decided;
}

function auditDecision(record: ApprovalRequest, reviewer: string, action: string): void {
  try {
    emitAuditEvent({
      type: "approval_decision",
      action,
      target: record.datasourceId,
      connectionName: record.datasourceName,
      user: reviewer,
      result: "success",
      approvalId: record.id,
      reviewer,
    });
  } catch (auditError) {
    logger.error("Failed to record approval_decision audit event", auditError, { route: "approvals/store" });
  }
}
