import { canWrite, isReadStatement } from "@/lib/access";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { ManagedConnection } from "@/lib/seed";
import type { UserPayload } from "@/lib/auth";

/**
 * The write gate every execution route runs before the provider (docs/CONTEXT.md §4.4):
 * a session that may not write to this datasource may only run statements that read.
 *
 * Refusal is a 403 through `SeedConnectionError`, so `createErrorResponse` answers it the
 * way it answers every other access refusal, and an audited `permission_denied` with the
 * datasource's own reason - metered like a role denial, because a session can poll this
 * in a loop too. The statement text never reaches the audit line.
 */
export function assertWriteAllowed(opts: {
  route: string;
  session: UserPayload;
  connection: ManagedConnection;
  statements: readonly string[];
  request: Request;
}): void {
  if (canWrite(opts.connection, opts.session)) return;
  const offending = opts.statements.find((sql) => !isReadStatement(sql, opts.connection.type));
  if (offending === undefined) return;
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

/** The provider option that opens the engine's own read-only enforcement where it has one. */
export function providerAccessOptions(connection: ManagedConnection, session: UserPayload): { readOnly?: true } {
  return canWrite(connection, session) ? {} : { readOnly: true };
}
