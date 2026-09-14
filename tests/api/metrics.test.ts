import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

/**
 * GET /api/metrics (docs/CONTEXT.md §4.11): absent a METRICS_TOKEN the endpoint does not
 * exist; with one, only the matching Bearer gets the exposition, which carries the
 * registry plus the gauges computed at scrape time - and a store that is down is a series,
 * not a failed scrape. The store and the provider cache are mocked.
 */
let pending: { requestedAt: string }[] = [];
let storeFails = false;
let storeMissing = false;
mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => {
    if (storeMissing) return null;
    return {
      listApprovals: async () => {
        if (storeFails) throw new Error("store down");
        return pending;
      },
    };
  },
}));
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, info: () => {}, error: () => {}, debug: () => {} } }));

const { GET } = await import("@/app/api/metrics/route");
const { incrementCounter, registerGauge, resetMetrics } = await import("@/lib/metrics/registry");

const req = (auth?: string) =>
  new Request("http://localhost/api/metrics", { headers: auth ? { authorization: auth } : {} });
const saved = { token: process.env.METRICS_TOKEN, version: process.env.NEXT_PUBLIC_APP_VERSION };

describe("GET /api/metrics", () => {
  beforeEach(() => {
    resetMetrics();
    pending = [];
    storeFails = false;
    storeMissing = false;
    warn.mockClear();
    process.env.METRICS_TOKEN = "scrape-secret";
    process.env.NEXT_PUBLIC_APP_VERSION = "9.9.9";
  });

  afterEach(() => {
    if (saved.token === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = saved.token;
    if (saved.version === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
    else process.env.NEXT_PUBLIC_APP_VERSION = saved.version;
  });

  test("without METRICS_TOKEN the endpoint is a 404, whatever is presented", async () => {
    delete process.env.METRICS_TOKEN;
    expect((await GET(req("Bearer scrape-secret"))).status).toBe(404);
  });

  test("a missing, malformed, wrong or wrong-length Bearer is a 401", async () => {
    for (const auth of [undefined, "Basic x", "Bearer wrong-secret!", "Bearer scrape-secre", "Bearer "]) {
      expect((await GET(req(auth))).status).toBe(401);
    }
  });

  test("the matching Bearer gets the text exposition with the registry and the scrape-time gauges", async () => {
    incrementCounter("dbportal_audit_events_total", { event: "login_success", action: "login", outcome: "success" });
    pending = [{ requestedAt: new Date(Date.now() - 90_000).toISOString() }, { requestedAt: new Date().toISOString() }];
    registerGauge("dbportal_providers_cached", "Database providers held open in this process.", () => 3);
    const res = await GET(req("Bearer scrape-secret"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain('dbportal_audit_events_total{action="login",event="login_success",outcome="success"} 1');
    expect(text).toContain('dbportal_build_info{version="9.9.9"} 1');
    expect(text).toContain("dbportal_providers_cached 3");
    expect(text).toContain("dbportal_approvals_pending 2");
    expect(text).toMatch(/dbportal_approval_oldest_pending_seconds (89|90|91)\n/);
    expect(text).not.toContain("dbportal_store_scrape_failed");
  });

  test("no pending request is an age of 0; a store that is down is one series and one warning; no store is no queue series", async () => {
    let text = await (await GET(req("Bearer scrape-secret"))).text();
    expect(text).toContain("dbportal_approvals_pending 0");
    expect(text).toContain("dbportal_approval_oldest_pending_seconds 0");
    storeFails = true;
    text = await (await GET(req("Bearer scrape-secret"))).text();
    expect(text).toContain("dbportal_store_scrape_failed 1");
    expect(text).not.toContain("dbportal_approvals_pending");
    expect(warn).toHaveBeenCalledTimes(1);
    storeFails = false;
    storeMissing = true;
    text = await (await GET(req("Bearer scrape-secret"))).text();
    expect(text).not.toContain("dbportal_approvals_pending");
    expect(text).not.toContain("dbportal_store_scrape_failed");
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    text = await (await GET(req("Bearer scrape-secret"))).text();
    expect(text).toContain('dbportal_build_info{version="unknown"} 1');
  });
});
