import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * The Bearer guard (docs/CONTEXT.md §4.10): what a missing, malformed, unknown or revoked
 * token gets (401, audited as no_session, metered by address), what a known one gets (the
 * identity, rate limited under its own name), and that stamping last use can fail quietly.
 */
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, error, info: () => {}, debug: () => {} } }));
let identity: { token: { id: string }; session: { role: string; username: string } } | null = null;
let touchFails = false;
const touched = mock(async (_id: string) => {
  if (touchFails) throw new Error("disk");
});
mock.module("@/lib/service-tokens/store", () => ({
  authenticateServiceToken: async (secret: string) => (secret === "dbp_good" ? identity : null),
  touchServiceToken: (id: string) => touched(id),
}));

// docs/CONTEXT.md §4.19: a token's groups may put it in a named role, like a person's.
mock.module("@/lib/roles/store", () => ({
  withNamedRoles: async (s: Record<string, unknown>) => ({ ...s, namedRoles: ["bots"] }),
}));

const { guardServiceRoute } = await import("@/lib/api/service-auth");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");

const req = (auth?: string) =>
  new Request("http://localhost/api/v1/executions", { headers: auth ? { authorization: auth } : {} });
const route = "POST /api/v1/executions";

describe("guardServiceRoute", () => {
  beforeEach(() => {
    clearRateLimitState();
    audit.mockClear();
    warn.mockClear();
    touched.mockClear();
    touchFails = false;
    identity = { token: { id: "t1" }, session: { role: "user", username: "svc:bot" } };
  });

  test("no header, a non-Bearer header, and an unknown secret are 401, audited as no_session for anonymous", async () => {
    for (const auth of [undefined, "Basic abc", "Bearer dbp_wrong", "Bearer "]) {
      const result = await guardServiceRoute({ route, request: req(auth) });
      expect("response" in result && result.response.status).toBe(401);
    }
    const events = audit.mock.calls.map((c) => (c as unknown[])[0] as { reason: string; user: string; target: string });
    expect(events.length).toBe(4);
    for (const e of events) expect(e).toMatchObject({ reason: "no_session", user: "anonymous", target: route });
    expect(touched).not.toHaveBeenCalled();
  });

  test("a known secret yields the identity and stamps last use, once per request", async () => {
    const result = await guardServiceRoute({ route, request: req("Bearer dbp_good") });
    expect("identity" in result && result.identity.session.username).toBe("svc:bot");
    expect("identity" in result && result.identity.session.namedRoles).toEqual(["bots"]);
    await Promise.resolve();
    expect(touched).toHaveBeenCalledWith("t1");
    expect(audit).not.toHaveBeenCalled();
  });

  test("a failed last-use stamp is one warning, not a failed request", async () => {
    touchFails = true;
    const result = await guardServiceRoute({ route, request: req("Bearer dbp_good") });
    expect("identity" in result).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a busy token is throttled in the query bucket under its own name, audited once when it trips", async () => {
    let last: Awaited<ReturnType<typeof guardServiceRoute>> | null = null;
    for (let i = 0; i < 400; i += 1) {
      last = await guardServiceRoute({ route, request: req("Bearer dbp_good") });
      if ("response" in last) break;
    }
    expect(last && "response" in last && last.response.status).toBe(429);
    const throttled = audit.mock.calls.map(
      (c) => (c as unknown[])[0] as { type: string; user: string; bucket?: string },
    );
    expect(throttled.filter((e) => e.type === "rate_limit_exceeded")).toEqual([
      expect.objectContaining({ user: "svc:bot", bucket: "query" }),
    ]);
  });

  test("the anonymous audit line is metered by address, and a broken audit sink still answers 401", async () => {
    for (let i = 0; i < 20; i += 1) await guardServiceRoute({ route, request: req() });
    expect(audit.mock.calls.length).toBeLessThan(20);
    audit.mockImplementation(() => {
      throw new Error("sink");
    });
    clearRateLimitState();
    const result = await guardServiceRoute({ route, request: req() });
    expect("response" in result && result.response.status).toBe(401);
    expect(error).toHaveBeenCalled();
    audit.mockImplementation(() => ({}));
  });
});
