import { canWrite, isReadStatement } from "@/lib/access";
import { activeFreeze } from "@/lib/freezes/store";
import { firstGuardrail } from "@/lib/guardrails";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { ApprovalError } from "@/lib/approvals/errors";
import { requireWriteWindow } from "@/lib/approvals/store";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { ManagedConnection } from "@/lib/seed";
import type { UserPayload } from "@/lib/auth";

/** What an execution inside a write window carries into its audit line (§4.6). */
export interface WriteAccess {
  approvalId?: string;
  reviewer?: string;
}

/**
 * The write gate every execution route runs before the provider (docs/CONTEXT.md §4.4, §4.6):
 * a session that may not write to this datasource may only run statements that read, and on
 * a datasource that requires approval, a statement that writes runs only inside an open
 * write window - otherwise it becomes a pending request and does not run.
 *
 * Refusal is a 403 through `SeedConnectionError`, so `createErrorResponse` answers it the
 * way it answers every other access refusal, and an audited `permission_denied` with the
 * datasource's own reason - metered like a role denial, because a session can poll this
 * in a loop too. The statement text never reaches the audit line. The "awaiting approval"
 * answer is `ApprovalRequiredError`, a decision the same mapper turns into a 403 that
 * carries the request.
 */
export async function assertWriteAllowed(opts: {
  route: string;
  session: UserPayload;
  connection: ManagedConnection;
  statements: readonly string[];
  request: Request;
}): Promise<WriteAccess> {
  const offending = opts.statements.find((sql) => !isReadStatement(sql, opts.connection.type));
  if (offending === undefined) return {};
  if (!canWrite(opts.connection, opts.session)) {
    auditRoleDenial({
      route: opts.route,
      user: opts.session.username,
      request: opts.request,
      reason: "read_only_datasource",
    });
    throw new SeedConnectionError(
      `This datasource is read-only for you: only statements that read may run on "${opts.connection.name}"`,
      403,
    );
  }
  // A freeze window (§4.17) refuses every write it covers, approval or not, whoever asks.
  const frozen = await activeFreeze(opts.connection.seedId ?? opts.connection.id);
  if (frozen) {
    auditRoleDenial({ route: opts.route, user: opts.session.username, request: opts.request, reason: "freeze_window" });
    throw new SeedConnectionError(freezeMessage(opts.connection.name, frozen), 403);
  }
  // A guardrail (§4.15) holds the statement for a reviewer on any datasource that has not
  // opted out, whoever asks; the request records which one, so the reviewer sees why.
  const guardrail = opts.connection.guardrails === false ? null : firstGuardrail(opts.statements, opts.connection.type);
  if (!opts.connection.writeApproval && !guardrail) return {};
  try {
    const window = await requireWriteWindow({
      datasourceId: opts.connection.seedId ?? opts.connection.id,
      datasourceName: opts.connection.name,
      requester: opts.session.username,
      statement: offending,
      route: opts.route,
      ...(guardrail ? { guardrail } : {}),
    });
    return { approvalId: window.id, reviewer: window.reviewer };
  } catch (error) {
    if (error instanceof ApprovalError) throw new SeedConnectionError(error.message, error.statusCode);
    if (error instanceof Error && error.name === "ApprovalRequiredError") {
      auditRoleDenial({
        route: opts.route,
        user: opts.session.username,
        request: opts.request,
        reason: guardrail ? "guardrail" : "approval_required",
      });
    }
    throw error;
  }
}

/** What a refused write is told: the datasource, when the window ends, and why it exists. */
export function freezeMessage(datasourceName: string, window: { reason: string; until: string }): string {
  return `Writes on "${datasourceName}" are frozen until ${new Date(window.until).toISOString()}: ${window.reason}`;
}

/** The provider option that opens the engine's own read-only enforcement where it has one. */
export function providerAccessOptions(connection: ManagedConnection, session: UserPayload): { readOnly?: true } {
  return canWrite(connection, session) ? {} : { readOnly: true };
}
