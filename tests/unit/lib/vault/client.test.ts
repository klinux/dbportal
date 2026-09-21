import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@/lib/logger";
import {
  DEFAULT_VAULT_TIMEOUT_MS,
  VaultError,
  getVaultConfig,
  isVaultConfigured,
  issueDatabaseCredentials,
  forgetVaultSession,
  readKvSecret,
  resetVaultTransport,
  vaultDispatcher,
  vaultToken,
  writeKvSecret,
  startVaultTokenRenewal,
  RENEW_RETRY_MS,
} from "@/lib/vault/client";

/**
 * The two Vault calls a datasource credential needs (docs/CONTEXT.md §4.5), against a
 * mocked fetch: what is sent, what is read out of the answer, and that no error carries the
 * token or a secret.
 */
const ENV = [
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "VAULT_TOKEN_FILE",
  "VAULT_NAMESPACE",
  "VAULT_TIMEOUT_MS",
  "VAULT_CACERT",
  "VAULT_SKIP_VERIFY",
  "VAULT_ROLE_ID",
  "VAULT_SECRET_ID",
  "VAULT_APPROLE_MOUNT",
  "VAULT_TOKEN_RENEW",
] as const;
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB-test-only\n-----END CERTIFICATE-----";
const saved: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const kvAnswer = () => jsonResponse({ data: { data: { password: "kv-secret" } } });

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
    // Self-renewal has tests of its own below; off here so every other test sees its request first.
    process.env.VAULT_TOKEN_RENEW = "off";
    fetchSpy = spyOn(fetchHolder, "fetch");
    resetVaultTransport();
    forgetVaultSession();
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
      namespace: undefined,
      timeoutMs: DEFAULT_VAULT_TIMEOUT_MS,
      tls: { skipVerify: false },
      auth: { method: "token", token: "s.token-never-logged" },
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
      expect(getVaultConfig().auth).toEqual({ method: "token", token: "file-token" });
      writeFileSync(file, "");
      expect(() => getVaultConfig()).toThrow("VAULT_TOKEN_FILE");
      process.env.VAULT_TOKEN_FILE = join(dir, "missing");
      expect(() => getVaultConfig()).toThrow("VAULT_TOKEN_FILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An AppRole instead of a token that expires: the role and secret ids, the login mount, and
  // a given token still winning over them (the injector's token file is renewed by the injector).
  test("configuration: VAULT_ROLE_ID with VAULT_SECRET_ID is the AppRole method, and a token wins over it", () => {
    delete process.env.VAULT_TOKEN;
    process.env.VAULT_ROLE_ID = " role-uuid ";
    process.env.VAULT_SECRET_ID = "secret-uuid";
    expect(getVaultConfig().auth).toEqual({ method: "approle", mount: "approle", roleId: "role-uuid", secretId: "secret-uuid" });
    process.env.VAULT_APPROLE_MOUNT = "approle-prod";
    expect(getVaultConfig().auth).toMatchObject({ mount: "approle-prod" });
    process.env.VAULT_TOKEN = "s.given";
    expect(getVaultConfig().auth).toEqual({ method: "token", token: "s.given" });
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_SECRET_ID;
    expect(() => getVaultConfig()).toThrow("VAULT_ROLE_ID with VAULT_SECRET_ID");
  });

  const approle = () => {
    delete process.env.VAULT_TOKEN;
    process.env.VAULT_ROLE_ID = "role-uuid";
    process.env.VAULT_SECRET_ID = "secret-uuid-never-logged";
  };
  const loginAnswer = (token: string, lease?: number) =>
    jsonResponse({ auth: { client_token: token, ...(lease === undefined ? {} : { lease_duration: lease }) } });
  test("AppRole: one login, then the token on every request until 80% of its lease has passed", async () => {
    approle();
    process.env.VAULT_NAMESPACE = "team-a";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      fetchSpy.mockImplementationOnce(async () => loginAnswer("s.first", 100)).mockImplementation(async () => kvAnswer());
      await readKvSecret("secret", "db/orders");
      await readKvSecret("secret", "db/orders");
      const [loginUrl, loginInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(loginUrl).toBe("https://vault.internal:8200/v1/auth/approle/login");
      expect(loginInit.method).toBe("POST");
      expect(loginInit.headers).toEqual({ "content-type": "application/json", "X-Vault-Namespace": "team-a" });
      expect(JSON.parse(String(loginInit.body))).toEqual({ role_id: "role-uuid", secret_id: "secret-uuid-never-logged" });
      expect((fetchSpy.mock.calls[1] as [string, RequestInit])[1].headers).toMatchObject({ "X-Vault-Token": "s.first" });
      // The second request presented the cached token: three calls, one of them the login.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect((fetchSpy.mock.calls[2] as [string, RequestInit])[1].headers).toMatchObject({ "X-Vault-Token": "s.first" });
      // The login is logged with the lease, never the secret id or the token.
      expect(JSON.stringify(info.mock.calls)).toContain('"leaseS":100');
      expect(JSON.stringify(info.mock.calls)).not.toContain("never-logged");
      expect(JSON.stringify(info.mock.calls)).not.toContain("s.first");
      // Past 80% of a 100 s lease, the next request logs in again.
      now.mockReturnValue(1_000_000 + 81_000);
      fetchSpy.mockImplementationOnce(async () => loginAnswer("s.second", 100)).mockImplementation(async () => kvAnswer());
      await readKvSecret("secret", "db/orders");
      expect((fetchSpy.mock.calls[3] as [string])[0]).toContain("/auth/approle/login");
      expect((fetchSpy.mock.calls[4] as [string, RequestInit])[1].headers).toMatchObject({ "X-Vault-Token": "s.second" });
    } finally {
      now.mockRestore();
      info.mockRestore();
    }
  });

  test("AppRole: a token without a lease is kept, a burst shares one login, and a 403 logs in once more", async () => {
    approle();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      let logins = 0;
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes("/login")) {
          logins += 1;
          return loginAnswer(`s.${logins}`);
        }
        return kvAnswer();
      });
      const config = getVaultConfig();
      const tokens = await Promise.all([vaultToken(config), vaultToken(config), vaultToken(config)]);
      expect(tokens).toEqual(["s.1", "s.1", "s.1"]);
      expect(logins).toBe(1);
      // No lease means no expiry: much later, the same token.
      const now = spyOn(Date, "now").mockReturnValue(Date.now() + 365 * 86_400_000);
      try {
        expect(await vaultToken(config)).toBe("s.1");
      } finally {
        now.mockRestore();
      }
      // Vault stops accepting it: one new login, the request tried again, and the answer is the second one's.
      let refusals = 0;
      fetchSpy.mockImplementation(async (url) => {
        if (String(url).includes("/login")) {
          logins += 1;
          return loginAnswer(`s.${logins}`);
        }
        refusals += 1;
        return refusals === 1 ? jsonResponse({ errors: ["permission denied"] }, 403) : kvAnswer();
      });
      expect(await readKvSecret("secret", "db/orders")).toEqual({ password: "kv-secret" });
      expect(logins).toBe(2);
      // A second refusal is the answer, with no third login.
      fetchSpy.mockImplementation(async (url) =>
        String(url).includes("/login") ? loginAnswer("s.3") : jsonResponse({ errors: ["permission denied"] }, 403),
      );
      const denied = await readKvSecret("secret", "db/orders").catch((e) => e);
      expect(denied).toBeInstanceOf(VaultError);
      expect(denied.status).toBe(403);
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("/login"))).toHaveLength(3);
    } finally {
      info.mockRestore();
    }
  });

  test("AppRole: a login that fails is a VaultError that never carries the secret id", async () => {
    approle();
    const cases: [() => Promise<Response>, string][] = [
      [async () => jsonResponse({ errors: ["invalid secret id"] }, 400), "Vault refused the AppRole login with 400"],
      [async () => new Response("<html>", { status: 200 }), "not JSON"],
      [async () => jsonResponse({ auth: {} }), "without a token"],
      [async () => Promise.reject(new TypeError("connect ECONNREFUSED")), "Vault AppRole login failed: TypeError"],
    ];
    for (const [answer, message] of cases) {
      fetchSpy.mockImplementation(answer);
      const err = await readKvSecret("secret", "x").catch((e) => e);
      expect(err).toBeInstanceOf(VaultError);
      expect(err.message).toContain(message);
      expect(err.message).not.toContain("never-logged");
    }
  });

  // A periodic token lives as long as it is renewed: renew-self before the first request, then
  // at half of each lease Vault answers with; a token Vault does not renew is asked once.
  test("token: renewed before the first request and again at half its lease, never the secret in the log", async () => {
    process.env.VAULT_TOKEN_RENEW = "on";
    process.env.VAULT_NAMESPACE = "team-a";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const now = spyOn(Date, "now").mockReturnValue(5_000_000);
    try {
      fetchSpy.mockImplementation(async (url) =>
        String(url).endsWith("/auth/token/renew-self") ? jsonResponse({ auth: { lease_duration: 3600 } }) : kvAnswer(),
      );
      await readKvSecret("secret", "db/orders");
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://vault.internal:8200/v1/auth/token/renew-self");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "X-Vault-Token": "s.token-never-logged", "X-Vault-Namespace": "team-a" });
      expect(JSON.stringify(info.mock.calls)).toContain('"leaseS":3600');
      expect(JSON.stringify(info.mock.calls)).not.toContain("never-logged");
      // Within half the lease: no renewal, the request alone.
      now.mockReturnValue(5_000_000 + 1_700_000);
      await readKvSecret("secret", "db/orders");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      // Past it: renewed again.
      now.mockReturnValue(5_000_000 + 1_900_000);
      await readKvSecret("secret", "db/orders");
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      expect((fetchSpy.mock.calls[3] as [string])[0]).toContain("/renew-self");
    } finally {
      now.mockRestore();
      info.mockRestore();
    }
  });

  // docs/CONTEXT.md §4.5: renewal from boot, whether or not anything reads a secret - the
  // token used to expire on a quiet weekend, and every Vault datasource failed at once.
  test("token: the background loop renews at boot and ticks; one loop per process; nothing to renew answers null", async () => {
    process.env.VAULT_TOKEN_RENEW = "on";
    spyOn(logger, "info").mockImplementation(() => {});
    const renewals = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/renew-self")).length;
    fetchSpy.mockImplementation(async () => jsonResponse({ auth: { lease_duration: 3600 } }));
    const stop = startVaultTokenRenewal(5);
    try {
      expect(stop).not.toBeNull();
      // A second start is the same loop, not a second timer.
      expect(startVaultTokenRenewal(5)).toBe(stop);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Renewed once at boot; the following ticks found the lease not yet half spent.
      expect(renewals()).toBe(1);
    } finally {
      stop!();
    }
    // Stopped: a new start is a new loop, and it renews at boot again.
    forgetVaultSession();
    const again = startVaultTokenRenewal(5);
    expect(again).not.toBe(stop);
    again!();
    expect(renewals()).toBe(2);

    // Nothing to renew: off, an AppRole login, no Vault at all, or a token that cannot be read.
    process.env.VAULT_TOKEN_RENEW = "off";
    expect(startVaultTokenRenewal(5)).toBeNull();
    process.env.VAULT_TOKEN_RENEW = "on";
    delete process.env.VAULT_TOKEN;
    process.env.VAULT_ROLE_ID = "r";
    process.env.VAULT_SECRET_ID = "s";
    expect(startVaultTokenRenewal(5)).toBeNull();
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    process.env.VAULT_TOKEN_FILE = "/nonexistent/vault-token";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    expect(startVaultTokenRenewal(5)).toBeNull();
    expect(warn).toHaveBeenCalledWith("Vault token renewal not started", expect.objectContaining({ error: "VaultError" }));
    delete process.env.VAULT_TOKEN_FILE;
    delete process.env.VAULT_ADDR;
    expect(startVaultTokenRenewal(5)).toBeNull();
    expect(renewals()).toBe(2);
  });

  test("token: a 403 at renewal is asked again in a minute, so an expired token is a warning every minute rather than silence", async () => {
    process.env.VAULT_TOKEN_RENEW = "on";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const now = spyOn(Date, "now").mockReturnValue(9_000_000);
    const renewals = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/renew-self")).length;
    try {
      fetchSpy.mockImplementation(async (url) =>
        String(url).endsWith("/renew-self") ? jsonResponse({ errors: ["permission denied"] }, 403) : kvAnswer(),
      );
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(1);
      expect(warn).toHaveBeenCalledWith("Vault token renewal failed", expect.objectContaining({ status: 403 }));
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(1);
      now.mockReturnValue(9_000_000 + RENEW_RETRY_MS + 1);
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  test("token: a renewal Vault refuses is not asked again; one that fails is retried in a minute; off leaves it alone", async () => {
    process.env.VAULT_TOKEN_RENEW = "on";
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const now = spyOn(Date, "now").mockReturnValue(7_000_000);
    const renewals = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/renew-self")).length;
    try {
      // 400: the root token, or one without a TTL - Vault does not renew it, and it is not asked again.
      fetchSpy.mockImplementation(async (url) =>
        String(url).endsWith("/renew-self") ? jsonResponse({ errors: ["lease is not renewable"] }, 400) : kvAnswer(),
      );
      await readKvSecret("secret", "x");
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(1);
      expect(JSON.stringify(info.mock.calls)).toContain("not renewable");
      // A new token starts over; Vault down at renewal is a warning and a retry a minute later.
      process.env.VAULT_TOKEN = "s.other";
      forgetVaultSession();
      fetchSpy.mockImplementation(async (url) =>
        String(url).endsWith("/renew-self") ? Promise.reject(new TypeError("fetch failed")) : kvAnswer(),
      );
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(2);
      expect(warn).toHaveBeenCalledWith("Vault token renewal failed", expect.objectContaining({ error: "TypeError" }));
      now.mockReturnValue(7_000_000 + 30_000);
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(2);
      now.mockReturnValue(7_000_000 + 61_000);
      // A 5xx is the same: a warning, a retry later. A 2xx without a lease renews and asks again in a minute.
      fetchSpy.mockImplementation(async (url) =>
        String(url).endsWith("/renew-self") ? new Response("busy", { status: 503 }) : kvAnswer(),
      );
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(3);
      expect(warn).toHaveBeenCalledWith("Vault token renewal failed", expect.objectContaining({ status: 503 }));
      now.mockReturnValue(7_000_000 + 122_000);
      fetchSpy.mockImplementation(async (url) =>
        String(url).endsWith("/renew-self") ? new Response("<html>", { status: 200 }) : kvAnswer(),
      );
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(4);
      now.mockReturnValue(7_000_000 + 123_000);
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(4);
      // Off: the token is whoever supplied it's to renew.
      process.env.VAULT_TOKEN_RENEW = "off";
      now.mockReturnValue(7_000_000 + 999_000);
      await readKvSecret("secret", "x");
      expect(renewals()).toBe(4);
    } finally {
      now.mockRestore();
      warn.mockRestore();
      info.mockRestore();
    }
  });

  // The Vault CLI's own two settings, for a Vault on an internal name: the CA as a file or
  // as the PEM itself (what a chart hands over without a volume), and the skip.
  test("configuration: VAULT_CACERT is read as a file or taken as PEM text, VAULT_SKIP_VERIFY as a flag", () => {
    process.env.VAULT_CACERT = PEM;
    expect(getVaultConfig().tls).toEqual({ skipVerify: false, ca: PEM });
    const dir = mkdtempSync(join(tmpdir(), "dbportal-vault-ca-"));
    try {
      const file = join(dir, "ca.pem");
      writeFileSync(file, `${PEM}\n`);
      process.env.VAULT_CACERT = file;
      process.env.VAULT_SKIP_VERIFY = "TRUE";
      expect(getVaultConfig().tls).toEqual({ skipVerify: true, ca: PEM });
      // An unreadable or empty CA is refused, not silently replaced by the bundle it was meant to replace.
      writeFileSync(file, "");
      expect(() => getVaultConfig()).toThrow("VAULT_CACERT");
      process.env.VAULT_CACERT = join(dir, "missing.pem");
      expect(() => getVaultConfig()).toThrow("VAULT_CACERT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.VAULT_CACERT;
    process.env.VAULT_SKIP_VERIFY = "no";
    expect(getVaultConfig().tls).toEqual({ skipVerify: false });
  });

  // One dispatcher per distinct setting, kept so its pool is reused, and only when a
  // setting asks for one - the default verification goes through the default fetch.
  test("the dispatcher exists only for a TLS setting, is reused, and the skip is logged once as a warning", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      expect(vaultDispatcher({ skipVerify: false })).toBeUndefined();
      const skip = vaultDispatcher({ skipVerify: true });
      expect(skip).toBeDefined();
      expect(vaultDispatcher({ skipVerify: true })).toBe(skip!);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("VAULT_SKIP_VERIFY");
      const trusted = vaultDispatcher({ skipVerify: false, ca: PEM });
      expect(trusted).not.toBe(skip!);
      expect(info).toHaveBeenCalledTimes(1);
      expect(vaultDispatcher({ skipVerify: false, ca: PEM })).toBe(trusted!);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  test("a request carries the dispatcher when a TLS setting is on, and none otherwise", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ data: { data: { password: "kv-secret" } } }));
    await readKvSecret("secret", "db/orders");
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1]).not.toHaveProperty("dispatcher");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.VAULT_SKIP_VERIFY = "1";
      await readKvSecret("secret", "db/orders");
      const init = (fetchSpy.mock.calls[1] as [string, RequestInit & { dispatcher?: unknown }])[1];
      expect(init.dispatcher).toBeDefined();
      // Never the CA or the flag in what is logged beside the request.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("kv-secret");
    } finally {
      warn.mockRestore();
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

  // The one write this client makes (docs/CONTEXT.md §4.54): a KV v2 version, POSTed with
  // the same headers a read carries, and a 204 accepted as done.
  test("writeKvSecret posts the fields as a KV v2 version, and takes a 204 as done", async () => {
    process.env.VAULT_NAMESPACE = "team-a";
    fetchSpy.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(writeKvSecret("secret", "datasources/shop", { user: "dbportal_shop", password: "pw" })).resolves.toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vault.internal:8200/v1/secret/data/datasources/shop");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "X-Vault-Token": "s.token-never-logged",
      "X-Vault-Namespace": "team-a",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({ data: { user: "dbportal_shop", password: "pw" } });

    fetchSpy.mockImplementation(async () => jsonResponse({ data: { version: 2 } }));
    await expect(writeKvSecret("secret", "datasources/shop", { password: "pw2" })).resolves.toBeUndefined();
  });

  test("writeKvSecret reports a refusal with the status, never the fields", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ errors: ["permission denied"] }, 403));
    const err = await writeKvSecret("secret", "datasources/shop", { password: "pw" }).catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).toBe("Vault answered 403 for secret/data/datasources/shop");
    expect(err.message).not.toContain("pw");
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
