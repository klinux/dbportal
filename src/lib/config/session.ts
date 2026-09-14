/**
 * The session's lifetime (docs/CONTEXT.md §4.26): short, renewed while in use, and never
 * beyond an absolute bound from the login itself. Pure over the environment and a token's
 * claims, so the proxy - which renews - and `login()` - which mints - decide the same way.
 */
const MINUTE = 60;
const HOUR = 3600;

/** How long a session lives without being used. */
export function sessionTtlSeconds(): number {
  return bounded(process.env.SESSION_TTL_MINUTES, 120, 5, 24 * 60) * MINUTE;
}

/** How long a session may be renewed after the login that started it. */
export function sessionMaxSeconds(): number {
  return bounded(process.env.SESSION_MAX_HOURS, 12, 1, 24 * 7) * HOUR;
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface SessionClaims {
  exp?: number;
  iat?: number;
  /** When the person authenticated; kept across renewals, never moved. */
  auth_time?: number;
}

/** Whether a valid token is in the second half of its life and still inside the absolute bound. */
export function shouldRenew(claims: SessionClaims, nowSeconds: number): boolean {
  if (typeof claims.exp !== "number") return false;
  const left = claims.exp - nowSeconds;
  if (left > sessionTtlSeconds() / 2) return false;
  const started = typeof claims.auth_time === "number" ? claims.auth_time : claims.iat;
  if (typeof started !== "number") return false;
  return nowSeconds + sessionTtlSeconds() <= started + sessionMaxSeconds();
}

/** The claims a renewed token carries: the identity and the login instant, never the old times. */
export function renewalClaims(payload: Record<string, unknown>): Record<string, unknown> {
  const { exp: _exp, iat: _iat, nbf: _nbf, jti: _jti, ...rest } = payload;
  return { ...rest, auth_time: typeof payload.auth_time === "number" ? payload.auth_time : payload.iat };
}

/** The operator's AUTH_COOKIE_SECURE, or undefined to let the request decide; "invalid" for a spelling nobody meant. */
export function parseCookieSecureOverride(raw: string | undefined): boolean | undefined | "invalid" {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["off", "false", "0"].includes(normalized)) return false;
  if (["on", "true", "1"].includes(normalized)) return true;
  return "invalid";
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Whether the session cookie carries Secure: the override when set, otherwise Secure in
 * production unless the request arrived on a loopback host over plain http (see auth.ts).
 */
export function cookieSecureFor(input: {
  override: boolean | undefined;
  production: boolean;
  host: string | null;
  forwardedProto: string | null;
}): boolean {
  if (input.override !== undefined) return input.override;
  if (!input.production) return false;
  if (!isLoopbackHost(input.host)) return true;
  return input.forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** The cookie's attributes, the same from `login()` and from a renewal in the proxy. */
export function sessionCookieAttributes(secure: boolean, path: string) {
  return {
    httpOnly: true,
    secure,
    // Must stay "lax" and must NOT be tightened to "strict": the OIDC callback depends on lax's
    // top-level-GET exception to return the oidc-state cookie. The cases lax does not cover -
    // notably a cross-site POST /api/auth/login, where there is no pre-existing cookie to withhold
    // - are covered by the Origin check in src/proxy.ts (src/lib/api/origin-check.ts).
    sameSite: "lax" as const,
    maxAge: sessionTtlSeconds(),
    path,
  };
}
