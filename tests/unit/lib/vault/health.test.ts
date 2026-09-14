import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { HEALTH_TIMEOUT_MS, vaultHealthy } from "@/lib/vault/health";

/**
 * The Vault readiness check (docs/CONTEXT.md §4.13): skipped without VAULT_ADDR, ok on any
 * 2xx from sys/health (standby answers included through the query), failed on a sealed or
 * unreachable Vault - and never a throw, never the token on the wire.
 */
type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
const VARS = ["VAULT_ADDR", "VAULT_TOKEN", "VAULT_TOKEN_FILE", "VAULT_NAMESPACE"];
const saved: Record<string, string | undefined> = {};
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;

describe("vaultHealthy", () => {
  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    process.env.VAULT_ADDR = "https://vault.internal:8200/";
    process.env.VAULT_TOKEN = "s.never-sent";
    fetchSpy = spyOn(holder, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  test("unconfigured is skipped, without a request", async () => {
    delete process.env.VAULT_ADDR;
    expect(await vaultHealthy()).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("asks sys/health with standby accepted, a timeout, the namespace when set, and never the token", async () => {
    process.env.VAULT_NAMESPACE = "team-a";
    expect(await vaultHealthy()).toBe("ok");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vault.internal:8200/v1/sys/health?standbyok=true&perfstandbyok=true");
    expect(init.headers).toEqual({ "X-Vault-Namespace": "team-a" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init)).not.toContain("never-sent");
    expect(HEALTH_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  test("without a namespace no header is sent; a sealed Vault (503) or a network failure is failed", async () => {
    expect(await vaultHealthy()).toBe("ok");
    expect((fetchSpy.mock.calls[0] as unknown[])[1]).not.toHaveProperty("headers");
    fetchSpy.mockImplementation(async () => new Response("sealed", { status: 503 }));
    expect(await vaultHealthy()).toBe("failed");
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await vaultHealthy()).toBe("failed");
  });

  test("a configuration the client refuses (no token at all) is failed, not a throw", async () => {
    delete process.env.VAULT_TOKEN;
    expect(await vaultHealthy()).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
