import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VAULT_TIMEOUT_MS,
  VaultError,
  getVaultConfig,
  isVaultConfigured,
  issueDatabaseCredentials,
  readKvSecret,
} from "@/lib/vault/client";

/**
 * The two Vault calls a datasource credential needs (docs/CONTEXT.md §4.5), against a
 * mocked fetch: what is sent, what is read out of the answer, and that no error carries the
 * token or a secret.
 */
const ENV = ["VAULT_ADDR", "VAULT_TOKEN", "VAULT_TOKEN_FILE", "VAULT_NAMESPACE", "VAULT_TIMEOUT_MS"] as const;
const saved: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const fetchHolder = globalThis as unknown as { fetch: FetchLike };

describe("vault client", () => {
  let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;

  beforeEach(() => {
    for (const key of ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.VAULT_ADDR = "https://vault.internal:8200/";
    process.env.VAULT_TOKEN = "s.token-never-logged";
    fetchSpy = spyOn(fetchHolder, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("configuration: address without its trailing slash, token, namespace, and a bounded timeout", () => {
    expect(isVaultConfigured()).toBe(true);
    expect(getVaultConfig()).toEqual({
      addr: "https://vault.internal:8200",
      token: "s.token-never-logged",
      namespace: undefined,
      timeoutMs: DEFAULT_VAULT_TIMEOUT_MS,
    });
    process.env.VAULT_NAMESPACE = "team-a";
    process.env.VAULT_TIMEOUT_MS = "250";
    expect(getVaultConfig()).toMatchObject({ namespace: "team-a", timeoutMs: 250 });
    process.env.VAULT_TIMEOUT_MS = "-1";
    expect(getVaultConfig().timeoutMs).toBe(DEFAULT_VAULT_TIMEOUT_MS);
  });

  test("configuration: a missing address or token is a VaultError, not a request", () => {
    delete process.env.VAULT_ADDR;
    expect(isVaultConfigured()).toBe(false);
    expect(() => getVaultConfig()).toThrow(VaultError);
    process.env.VAULT_ADDR = "https://vault.internal";
    delete process.env.VAULT_TOKEN;
    expect(() => getVaultConfig()).toThrow("VAULT_TOKEN");
  });

  // What the Kubernetes injector and Vault Agent leave behind: read on every call, so a
  // renewed file is used without a restart.
  test("configuration: a token file wins over the variable, and an unreadable or empty one is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "dbportal-vault-"));
    try {
      const file = join(dir, "token");
      writeFileSync(file, "  file-token\n");
      process.env.VAULT_TOKEN_FILE = file;
      expect(getVaultConfig().token).toBe("file-token");
      writeFileSync(file, "");
      expect(() => getVaultConfig()).toThrow("VAULT_TOKEN_FILE");
      process.env.VAULT_TOKEN_FILE = join(dir, "missing");
      expect(() => getVaultConfig()).toThrow("VAULT_TOKEN_FILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readKvSecret reads one field of a KV v2 secret with the token and namespace headers", async () => {
    process.env.VAULT_NAMESPACE = "team-a";
    fetchSpy.mockImplementation(async () => jsonResponse({ data: { data: { password: "kv-secret", other: 1 } } }));
    expect(await readKvSecret("secret", "db/orders")).toEqual({ password: "kv-secret", other: 1 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vault.internal:8200/v1/secret/data/db/orders");
    expect(init.headers).toEqual({ "X-Vault-Token": "s.token-never-logged", "X-Vault-Namespace": "team-a" });
    expect(init.cache).toBe("no-store");
  });

  test("readKvSecret refuses an answer without data, naming the path", async () => {
    for (const body of [{ data: {} }, { data: { data: ["x"] } }, {}]) {
      fetchSpy.mockImplementation(async () => jsonResponse(body));
      const err = await readKvSecret("secret", "db/orders").catch((e) => e);
      expect(err).toBeInstanceOf(VaultError);
      expect(err.message).toBe("Vault secret secret/db/orders has no data");
    }
  });

  test("issueDatabaseCredentials reads the credential and its lease", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        lease_id: "database/creds/orders/abc",
        lease_duration: 3600,
        data: { username: "v-token-orders-x", password: "issued" },
      }),
    );
    expect(await issueDatabaseCredentials("database", "orders")).toEqual({
      username: "v-token-orders-x",
      password: "issued",
      leaseId: "database/creds/orders/abc",
      leaseDurationS: 3600,
    });
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe("https://vault.internal:8200/v1/database/creds/orders");
  });

  test("issueDatabaseCredentials: a lease without a duration reads as 0, and an answer without a credential is refused", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ data: { username: "u", password: "p" } }));
    expect(await issueDatabaseCredentials("database", "orders")).toMatchObject({ leaseId: "", leaseDurationS: 0 });
    fetchSpy.mockImplementation(async () => jsonResponse({ data: { username: "u" } }));
    await expect(issueDatabaseCredentials("database", "orders")).rejects.toThrow("without a username and password");
  });

  test("a non-2xx answer, a non-JSON body and a transport failure are each a VaultError that names the path", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ errors: ["permission denied"] }, 403));
    const denied = await readKvSecret("secret", "x").catch((e) => e);
    expect(denied).toBeInstanceOf(VaultError);
    expect(denied.status).toBe(403);
    expect(denied.message).toBe("Vault answered 403 for secret/data/x");

    fetchSpy.mockImplementation(async () => new Response("<html>", { status: 200 }));
    await expect(readKvSecret("secret", "x")).rejects.toThrow("not JSON");

    fetchSpy.mockImplementation(async () => Promise.reject(new TypeError("connect ECONNREFUSED 10.0.0.1")));
    const down = await readKvSecret("secret", "x").catch((e) => e);
    expect(down).toBeInstanceOf(VaultError);
    expect(down.message).toBe("Vault request for secret/data/x failed: TypeError");
  });

  // The timeout is the abort signal handed to fetch; a Vault that hangs must not hang a query.
  test("a request that outlives VAULT_TIMEOUT_MS is aborted", async () => {
    process.env.VAULT_TIMEOUT_MS = "20";
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const err = await readKvSecret("secret", "x").catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).toContain("AbortError");
  });
});
