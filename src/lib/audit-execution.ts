import { emitAuditEvent, isStatementAuditEnabled, type AuditReason } from "@/lib/audit";
import {
  AuthenticationError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { observeExecution } from "@/lib/metrics/registry";

/**
 * The audit line for a HUMAN execution (docs/CONTEXT.md §4.2): every statement the editor
 * runs through the query, multi-query and transaction routes leaves one `query_execution`
 * event naming the person, the datasource, the outcome and the duration - and the statement
 * itself only when the operator opted in with AUDIT_INCLUDE_SQL.
 *
 * Why a wrapper around the provider call rather than a line in each route: the four things
 * that must hold everywhere - the failure reason is a closed value derived from the error
 * CLASS and never its message, the statement is gated by the flag in exactly one place, a
 * failed emit never turns a finished query into a 500, and the error is rethrown untouched so
 * `createErrorResponse` still answers it - are the things three copies would drift on.
 */

export type ExecutionAction =
  | "query"
  | "explain"
  | "multi-query"
  | "transaction:begin"
  | "transaction:commit"
  | "transaction:rollback"
  | "transaction:query";

export interface ExecutionAuditContext {
  /** "POST /api/db/query" - recorded verbatim as the target. */
  route: string;
  action: ExecutionAction;
  user: string;
  connectionName: string;
  /** The statement that ran. Recorded only under AUDIT_INCLUDE_SQL, bounded like every field. */
  statement?: string;
  ip?: string;
  /** The write window this ran under, when the datasource requires approval (§4.6). */
  approvalId?: string;
  reviewer?: string;
  /** The person a service token ran this for (§4.10). */
  subject?: string;
  /** The ticket or incident the execution was for (§4.18). */
  ticket?: string;
  /** The runbook the statement came from (§4.20). */
  runbook?: string;
}

/**
 * What the record says about why an execution failed. Derived from the error's class alone:
 * a driver message may quote the statement, a value from it, or the server's own reply, and
 * none of that may reach a record whose reason field is a closed union by design.
 */
export function executionFailureReason(error: unknown): AuditReason {
  if (error instanceof QueryCancelledError) return "query_cancelled";
  if (error instanceof TimeoutError) return "query_timeout";
  if (error instanceof AuthenticationError) return "database_auth_error";
  if (error instanceof DatabaseConfigError) return "database_config_error";
  if (error instanceof QueryError) return "query_error";
  return "execution_failed";
}

function record(
  context: ExecutionAuditContext,
  outcome: { result: "success" } | { result: "failure"; reason: AuditReason },
  duration: number,
) {
  // The latency series (docs/CONTEXT.md §4.11), whatever the outcome; in-process, cannot throw.
  observeExecution(context.route, context.connectionName, duration);
  // Isolated so a broken audit sink cannot turn an execution that already finished into an
  // unrelated 500 - the same rule guardRoute applies to its own emits.
  try {
    emitAuditEvent({
      type: "query_execution",
      action: context.action,
      target: context.route,
      connectionName: context.connectionName,
      user: context.user,
      result: outcome.result,
      duration,
      ...(outcome.result === "failure" ? { reason: outcome.reason } : {}),
      ...(context.approvalId ? { approvalId: context.approvalId, reviewer: context.reviewer } : {}),
      ...(context.subject ? { subject: context.subject } : {}),
      ...(context.ticket ? { ticket: context.ticket } : {}),
      ...(context.runbook ? { runbook: context.runbook } : {}),
      ...(context.ip ? { ip: context.ip } : {}),
      ...(context.statement !== undefined && isStatementAuditEnabled() ? { details: context.statement } : {}),
    });
  } catch (auditError) {
    logger.error("Failed to record query_execution audit event", auditError, { route: context.route });
  }
}

/**
 * Run `invoke` and record it. The result and the error both pass through untouched.
 */
export async function auditExecution<T>(context: ExecutionAuditContext, invoke: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await invoke();
    record(context, { result: "success" }, Date.now() - started);
    return result;
  } catch (error) {
    record(context, { result: "failure", reason: executionFailureReason(error) }, Date.now() - started);
    throw error;
  }
}
