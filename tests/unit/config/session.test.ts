import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  cookieSecureFor,
  isLoopbackHost,
  parseCookieSecureOverride,
  renewalClaims,
  sessionCookieAttributes,
  sessionMaxSeconds,
  sessionTtlSeconds,
  shouldRenew,
} from "@/lib/config/session";

/**
 * The session's lifetime (docs/CONTEXT.md §4.26): the two bounds from the environment,
 * when a token is renewed, what a renewed token carries, and the cookie decisions the proxy
 * and login() share.
 */
const saved: Record<string, string | undefined> = {};
const KEYS = ["SESSION_TTL_MINUTES", "SESSION_MAX_HOURS"];

describe("session lifetime", () => {
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("the bounds default to two hours and twelve hours, read the environment, and stay inside their limits", () => {
    expect(sessionTtlSeconds()).toBe(120 * 60);
    expect(sessionMaxSeconds()).toBe(12 * 3600);
    process.env.SESSION_TTL_MINUTES = "30";
    process.env.SESSION_MAX_HOURS = "48";
    expect(sessionTtlSeconds()).toBe(30 * 60);
    expect(sessionMaxSeconds()).toBe(48 * 3600);
    process.env.SESSION_TTL_MINUTES = "1";
    process.env.SESSION_MAX_HOURS = "9999";
    expect(sessionTtlSeconds()).toBe(5 * 60);
    expect(sessionMaxSeconds()).toBe(168 * 3600);
    process.env.SESSION_TTL_MINUTES = "soon";
    expect(sessionTtlSeconds()).toBe(120 * 60);
  });

  test("a token is renewed in the second half of its life, inside the absolute bound, and never otherwise", () => {
    const now = 1_700_000_000;
    const ttl = 120 * 60;
    expect(shouldRenew({ exp: now + ttl - 10, iat: now - 10 }, now)).toBe(false);
    expect(shouldRenew({ exp: now + ttl / 2 - 1, iat: now - ttl / 2 }, now)).toBe(true);
    expect(shouldRenew({ exp: now + 60, auth_time: now - 11 * 3600, iat: now - 3600 }, now)).toBe(false);
    expect(shouldRenew({ exp: now + 60, auth_time: now - 9 * 3600, iat: now - 3600 }, now)).toBe(true);
    expect(shouldRenew({ iat: now }, now)).toBe(false);
    expect(shouldRenew({ exp: now + 60 }, now)).toBe(false);
  });

  test("a renewed token keeps the identity and the login instant and drops the old times", () => {
    expect(
      renewalClaims({ role: "user", username: "ana", groups: ["sre"], iat: 1, exp: 2, nbf: 1, jti: "x", auth_time: 5 }),
    ).toEqual({
      role: "user",
      username: "ana",
      groups: ["sre"],
      auth_time: 5,
    });
    expect(renewalClaims({ role: "user", iat: 7 }).auth_time).toBe(7);
  });

  test("the cookie: override, production, loopback and the forwarded protocol; the attributes login() and the proxy share", () => {
    expect(parseCookieSecureOverride(undefined)).toBeUndefined();
    expect(parseCookieSecureOverride(" FALSE ")).toBe(false);
    expect(parseCookieSecureOverride("1")).toBe(true);
    expect(parseCookieSecureOverride("maybe")).toBe("invalid");
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
    expect(isLoopbackHost("db.example.test")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(cookieSecureFor({ override: false, production: true, host: "x", forwardedProto: "https" })).toBe(false);
    expect(cookieSecureFor({ override: undefined, production: false, host: "x", forwardedProto: null })).toBe(false);
    expect(cookieSecureFor({ override: undefined, production: true, host: "x.test", forwardedProto: null })).toBe(true);
    expect(
      cookieSecureFor({ override: undefined, production: true, host: "localhost:3000", forwardedProto: null }),
    ).toBe(false);
    expect(
      cookieSecureFor({ override: undefined, production: true, host: "localhost:3000", forwardedProto: "https, http" }),
    ).toBe(true);
    expect(sessionCookieAttributes(true, "/x")).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7200,
      path: "/x",
    });
  });
});
