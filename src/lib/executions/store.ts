import { randomUUID } from "node:crypto";
import { canWrite, isReadStatement } from "@/lib/access";
import { dangerOf } from "@/lib/guardrails";
import { capPrepareOptions, withConcurrency } from "@/lib/limits";
import { activeFreeze } from "@/lib/freezes/store";
import { freezeMessage } from "@/lib/api/write-gate";
import { readTicket } from "@/lib/api/ticket";
import { auditExecution } from "@/lib/audit-execution";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { providerAccessOptions } from "@/lib/api/write-gate";
import { ApprovalError } from "@/lib/approvals/errors";
import { NOTE_MAX_CHARS, STATEMENT_MAX_CHARS } from "@/lib/approvals/store";
import { logger } from "@/lib/logger";
import { maskResult } from "@/lib/masking/store";
import { notifyExecutionOutcome, notifyReviewers } from "@/lib/notify/slack";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { getStorageProvider } from "@/lib/storage/factory";
import type { ApprovalRequest, ExecutionOutcome, ExecutionReply } from "@/lib/storage/types";
import { findServiceTokenByActor } from "@/lib/service-tokens/store";
import { withNamedRoles } from "@/lib/roles/store";
import type { ServiceIdentity } from "@/lib/service-tokens/types";
import { executionFailureReason } from "@/lib/audit-execution";

/**
 * Executions requested by a service token (docs/CONTEXT.md §4.10). A bot posts a statement
 * for a datasource on behalf of a person; the server decides whether it may run now or
 * must wait for a reviewer, runs it itself when allowed - the bot is never handed a
 * connection - and keeps a bounded, masked outcome the bot reads back. A request that
 * waits is an `approval_requests` record of kind `execution`, so the reviewers' page and
 * its audit line are the ones §4.6 already has; approving one runs it instead of opening
 * a window, because the requester is not there to run it again.
 */
export const ROUTE = "POST /api/v1/executions";

/** Thrown inside a run when a freeze window covers the datasource at that moment. */
class FrozenError extends Error {
  constructor() {
    super("freeze window");
    this.name = "FrozenError";
  }
}
export const RESULT_MAX_ROWS = 200;
export const RESULT_MAX_BYTES = 256 * 1024;
const SUBJECT_MAX = 200;
const REPLY_FIELD_MAX = 80;

export interface ExecutionRequestInput {
  datasourceId: unknown;
  statement: unknown;
  onBehalfOf?: unknown;
  reply?: unknown;
  ticket?: unknown;
}

function readReply(value: unknown): ExecutionReply | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new ApprovalError("reply must be { channel, threadTs? }", 400);
  const { channel, threadTs } = value as Record<string, unknown>;
  if (typeof channel !== "string" || channel.length === 0 || channel.length > REPLY_FIELD_MAX)
    throw new ApprovalError("reply.channel must be a non-empty string", 400);
  if (threadTs !== undefined && (typeof threadTs !== "string" || threadTs.length > REPLY_FIELD_MAX))
    throw new ApprovalError("reply.threadTs must be a string", 400);
  return { channel, ...(typeof threadTs === "string" ? { threadTs } : {}) };
}

async function requireStore() {
  const provider = await getStorageProvider();
  if (!provider)
    throw new ApprovalError("Executions need server storage: set STORAGE_PROVIDER to sqlite or postgres", 503);
  return provider;
}

/** The rows that are kept: at most RESULT_MAX_ROWS, and never more than RESULT_MAX_BYTES of them. */
export function boundRows(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; truncated: boolean } {
  const kept: Record<string, unknown>[] = [];
  let bytes = 2;
  for (const row of rows.slice(0, RESULT_MAX_ROWS)) {
    bytes += JSON.stringify(row).length + 1;
    if (bytes > RESULT_MAX_BYTES) break;
    kept.push(row);
  }
  return { rows: kept, truncated: kept.length < rows.length };
}

/**
 * Run one execution record as the token that queued it, and store the outcome on it. The
 * audit line is the same `query_execution` a person's run leaves, with the token as actor,
 * the person as subject and, after a review, the reviewer.
 */
export async function runExecution(record: ApprovalRequest, identity: ServiceIdentity): Promise<ApprovalRequest> {
  const store = await requireStore();
  const startedAt = new Date();
  let outcome: ExecutionOutcome;
  try {
    const connection = await resolveConnection({ connectionId: `seed:${record.datasourceId}` }, identity.session);
    // Approved into a freeze window (§4.17): the statement does not run; the outcome says why.
    if (!isReadStatement(record.statement, connection.type) && (await activeFreeze(record.datasourceId))) {
      throw new FrozenError();
    }
    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(identity.session.username),
      ...providerAccessOptions(connection, identity.session),
    });
    const prepared = provider.prepareQuery(record.statement, capPrepareOptions({}, connection.limits));
    const result = await withConcurrency(connection, identity.session.username, () =>
      auditExecution(
        {
          route: ROUTE,
          action: "query",
          user: identity.session.username,
          connectionName: connection.name,
          statement: prepared.query,
          ...(record.reviewer ? { approvalId: record.id, reviewer: record.reviewer } : {}),
          subject: record.subject,
          ...(record.ticket ? { ticket: record.ticket } : {}),
        },
        () => provider.query(prepared.query),
      ),
    );
    const masked = await maskResult(result, {
      session: identity.session,
      connectionName: connection.name,
      reveal: false,
    });
    const bounded = boundRows(masked.rows);
    outcome = {
      status: "done",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      rowCount: masked.rowCount,
      fields: masked.fields,
      rows: bounded.rows,
      ...(bounded.truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    // The reason is a closed word; the driver's message stays in the server log, never here.
    const reason =
      error instanceof FrozenError
        ? "freeze_window"
        : error instanceof SeedConnectionError
          ? "permission_denied"
          : executionFailureReason(error);
    logger.warn("Queued execution failed", { route: ROUTE, approvalId: record.id, reason });
    outcome = {
      status: "failed",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      error: reason,
    };
  }
  const finished: ApprovalRequest = { ...record, execution: outcome };
  await store.putApproval(finished);
  void notifyExecutionOutcome(finished);
  return finished;
}

/**
 * A bot's request: validated, judged against the token and the datasource, then either run
 * now or queued for a reviewer. Returns the record; `status` says which happened.
 */
export async function submitExecution(
  input: ExecutionRequestInput,
  identity: ServiceIdentity,
): Promise<ApprovalRequest> {
  const datasourceId = typeof input.datasourceId === "string" ? input.datasourceId.trim() : "";
  if (!datasourceId) throw new ApprovalError("datasourceId is required", 400);
  const statement = typeof input.statement === "string" ? input.statement.trim() : "";
  if (!statement) throw new ApprovalError("statement is required", 400);
  if (statement.length > STATEMENT_MAX_CHARS)
    throw new ApprovalError(`statement is longer than ${STATEMENT_MAX_CHARS} characters`, 400);
  const subject = typeof input.onBehalfOf === "string" ? input.onBehalfOf.trim().slice(0, SUBJECT_MAX) : "";
  if (!subject) throw new ApprovalError("onBehalfOf is required: the person the request is for", 400);
  const reply = readReply(input.reply);
  const { token } = identity;
  if (token.datasources && token.datasources.length > 0 && !token.datasources.includes(datasourceId)) {
    throw new ApprovalError(`This token may not use datasource "${datasourceId}"`, 403);
  }
  // Resolving applies the datasource's own access rule to the token's role and groups.
  const connection = await resolveConnection({ connectionId: `seed:${datasourceId}` }, identity.session);
  const writes = !isReadStatement(statement, connection.type);
  if (writes && !canWrite(connection, identity.session)) {
    throw new ApprovalError(
      `This datasource is read-only for the token: only statements that read may run on "${connection.name}"`,
      403,
    );
  }
  const ticket = readTicket(input.ticket);
  if (writes) {
    if (connection.requireTicket && !ticket) {
      throw new ApprovalError(`A ticket or incident reference is required to write on "${connection.name}"`, 403);
    }
    const frozen = await activeFreeze(datasourceId);
    if (frozen) throw new ApprovalError(freezeMessage(connection.name, frozen), 403);
  }
  const guardrail = connection.guardrails === false ? null : dangerOf(statement, connection.type);
  const store = await requireStore();
  const record: ApprovalRequest = {
    id: randomUUID(),
    kind: "execution",
    ...(guardrail ? { guardrail } : {}),
    ...(ticket ? { ticket } : {}),
    datasourceId,
    datasourceName: connection.name,
    requester: identity.session.username,
    subject,
    statement,
    route: ROUTE,
    status: "pending",
    requestedAt: new Date().toISOString(),
    ...(reply ? { reply } : {}),
  };
  const needsReview = token.requireApproval || guardrail !== null || (writes && connection.writeApproval === true);
  if (needsReview) {
    await store.putApproval(record);
    logger.info("Execution queued for approval", {
      route: ROUTE,
      approvalId: record.id,
      datasourceId,
      user: record.requester,
    });
    void notifyReviewers(record);
    return record;
  }
  // Allowed as it is: recorded as approved by policy (no reviewer), then run.
  const approved: ApprovalRequest = { ...record, status: "approved", reviewedAt: record.requestedAt };
  await store.putApproval(approved);
  return runExecution(approved, identity);
}

/**
 * What a reviewer's decision sets in motion for an execution request: approved, it runs now
 * as the token that queued it (a token revoked meanwhile makes it fail as a permission
 * denial, the way the token's own call would); rejected, the thread that asked is told.
 * A window request is returned untouched.
 */
export async function settleDecision(decided: ApprovalRequest): Promise<ApprovalRequest> {
  if (decided.kind !== "execution") return decided;
  if (decided.status === "rejected") {
    void notifyExecutionOutcome(decided);
    return decided;
  }
  const found = await findServiceTokenByActor(decided.requester);
  const identity = found ? { ...found, session: await withNamedRoles(found.session) } : null;
  if (!identity) {
    const store = await requireStore();
    const now = new Date().toISOString();
    const failed: ApprovalRequest = {
      ...decided,
      execution: { status: "failed", startedAt: now, finishedAt: now, durationMs: 0, error: "token_revoked" },
    };
    await store.putApproval(failed);
    void notifyExecutionOutcome(failed);
    return failed;
  }
  return runExecution(decided, identity);
}

/** One record, only if this token queued it: a token never reads another's requests. */
export async function getExecutionForToken(id: string, identity: ServiceIdentity): Promise<ApprovalRequest | null> {
  const store = await requireStore();
  const record = await store.getApproval(id);
  if (!record || record.kind !== "execution" || record.requester !== identity.session.username) return null;
  return record;
}

/** The bounded note a reviewer may leave; re-exported so the decision path and this module agree. */
export const EXECUTION_NOTE_MAX = NOTE_MAX_CHARS;
