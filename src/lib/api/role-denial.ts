import { clientAddress } from "@/lib/api/client-address";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * The audit line for a ROLE denial: an authenticated caller that holds a session but not the role
 * an action requires. `guardRoute` (src/lib/api/require-session.ts) cannot record it, because the
 * places that need it decide the role after their own session check: admin-only routes inside
 * their handler, and `resolveConnection` when a non-admin body carries its own connection.
 *
 * Its own module rather than a sibling of `guardRoute`: `resolveConnection` needs it, and
 * `require-session` reaches `resolveConnection` through `src/lib/api/errors.ts`
 * (`SeedConnectionError`). Importing back from there would close an import cycle.
 *
 * METERED, on the same `anon` bucket and for the same reason the `no_session` line in `guardRoute`
 * is: the denial is unconditional, only its record is bounded. Holding a signed non-admin token
 * bounds how many IDENTITIES can reach this branch, not how many requests each one makes - a single
 * session, stolen or not, can poll an admin route in a loop, and every line would both fill a
 * container log volume and evict real events from the 1000-entry ring the admin UI reads. Keyed on
 * the username rather than the address so one account cannot buy more lines by rotating
 * `X-Forwarded-For`.
 *
 * `request` is optional because `resolveConnection` never sees one; the line then carries no
 * address hint, which is what the audit schema already allows for events with no request context.
 *
 * Isolated in its own try/catch for the same reason guardRoute isolates its emits: the 403 is
 * already decided, and a broken audit sink must never turn a denial into an unrelated 500.
 */
export function auditRoleDenial(opts: { route: string; user: string; request?: Request }): void {
  const notice = consumeRateLimit("anon", opts.user);
  if (!notice.allowed && !notice.tripped) return;
  try {
    emitAuditEvent({
      type: "permission_denied",
      action: "denied",
      target: opts.route,
      user: opts.user,
      result: "failure",
      reason: "insufficient_role",
      ...(opts.request ? { ip: clientAddress(opts.request) } : {}),
    });
  } catch (auditError) {
    logger.error("Failed to record permission_denied audit event", auditError, { route: opts.route });
  }
}
