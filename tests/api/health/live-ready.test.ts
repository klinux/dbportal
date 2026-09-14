import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The two probes (docs/CONTEXT.md §4.13): liveness answers as long as the process does;
 * readiness asks the server store and Vault, each only when configured, and is 503 while
 * either fails. The store and the Vault check are mocked.
 */
let storageEnabled = true;
let provider: { isHealthy: () => Promise<boolean> } | null = { isHealthy: async () => true };
let storeThrows = false;
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => storageEnabled,
  getStorageProvider: async () => {
    if (storeThrows) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
    return provider;
  },
}));
let vault: "ok" | "failed" | "skipped" = "skipped";
mock.module("@/lib/vault/health", () => ({ vaultHealthy: async () => vault }));
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, info: () => {}, error: () => {}, debug: () => {} } }));

const { GET: live } = await import("@/app/api/health/live/route");
const { GET: ready } = await import("@/app/api/health/ready/route");

describe("health probes", () => {
  beforeEach(() => {
    storageEnabled = true;
    provider = { isHealthy: async () => true };
    storeThrows = false;
    vault = "skipped";
    warn.mockClear();
  });

  test("liveness is 200 and says nothing about dependencies", async () => {
    const res = await live();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "alive", service: "dbportal" });
    expect(body).not.toHaveProperty("checks");
  });

  test("readiness is 200 with the store ok and Vault skipped, and names both outcomes", async () => {
    const res = await ready();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ status: "ready", checks: { store: "ok", vault: "skipped" } });
  });

  test("a local store is skipped, not failed", async () => {
    storageEnabled = false;
    const res = await ready();
    expect(res.status).toBe(200);
    expect((await res.json()).checks.store).toBe("skipped");
  });

  test("a store that says it is unhealthy, one that cannot be resolved, and one that throws are each a 503; the error stays in the log", async () => {
    provider = { isHealthy: async () => false };
    expect((await ready()).status).toBe(503);
    provider = null;
    expect((await ready()).status).toBe(503);
    storeThrows = true;
    const res = await ready();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: "not_ready", checks: { store: "failed" } });
    expect(JSON.stringify(body)).not.toContain("10.0.0.1");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("Vault ok keeps 200 and Vault failed is a 503 even with the store fine", async () => {
    vault = "ok";
    expect((await ready()).status).toBe(200);
    vault = "failed";
    const res = await ready();
    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ store: "ok", vault: "failed" });
  });
});
