import { NextResponse } from "next/server";
import { withNamedRoles } from "@/lib/roles/store";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { consumeRateLimit, RateLimitError } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { authenticateServiceToken, touchServiceToken } from "@/lib/service-tokens/store";
import type { ServiceIdentity } from "@/lib/service-tokens/types";

/**
 * The guard for routes a bot calls with `Authorization: Bearer dbp_…` (docs/CONTEXT.md
 * §4.10): the `guardRoute` of the session routes, with the token where the cookie would be.
 * A missing or unknown token is a 401 audited as `no_session` (metered by address, as the
 * anonymous probes of the other routes are); a known one is rate limited in the `query`
 * bucket under its own actor name, so one busy bot cannot crowd out people.
 */
export type ServiceGuardResult = { response: NextResponse } | { identity: ServiceIdentity };

export async function guardServiceRoute(opts: { route: string; request: Request }): Promise<ServiceGuardResult> {
  const ip = clientAddress(opts.request);
  const header = opts.request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const found = secret ? await authenticateServiceToken(secret) : null;
  // A token's groups may put it in a named role (§4.19), like a person's.
  const identity = found ? { ...found, session: await withNamedRoles(found.session) } : null;
  if (!identity) {
    const notice = consumeRateLimit("anon", ip);
    if (notice.allowed || notice.tripped) {
      try {
        emitAuditEvent({
          type: "permission_denied",
          action: "denied",
          target: opts.route,
          user: "anonymous",
          result: "failure",
          reason: "no_session",
          ip,
        });
      } catch (auditError) {
        logger.error("Failed to record permission_denied audit event", auditError, { route: opts.route });
      }
    }
    return { response: NextResponse.json({ error: "A valid service token is required" }, { status: 401 }) };
  }
  const decision = consumeRateLimit("query", identity.session.username);
  if (!decision.allowed) {
    if (decision.tripped) {
      try {
        emitAuditEvent({
          type: "rate_limit_exceeded",
          action: "throttled",
          target: opts.route,
          user: identity.session.username,
          result: "failure",
          reason: "rate_limited",
          ip,
          bucket: "query",
        });
      } catch (auditError) {
        logger.error("Failed to record rate_limit_exceeded audit event", auditError, { route: opts.route });
      }
    }
    return { response: createErrorResponse(new RateLimitError(decision.retryAfterSeconds), { route: opts.route }) };
  }
  touchServiceToken(identity.token.id).catch((error: unknown) => {
    logger.warn("Service token last-used stamp not written", { route: opts.route, error: (error as Error).name });
  });
  return { identity };
}
