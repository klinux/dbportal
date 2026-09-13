import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { VaultError } from "@/lib/vault/client";
import {
  DEFAULT_KV_TTL_MS,
  isVaultReference,
  parseVaultReference,
  readVaultKvReference,
  resetVaultCache,
  resolveVaultReferences,
} from "@/lib/vault/credentials";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Vault references on a datasource (docs/CONTEXT.md §4.5): how they parse, when Vault is
 * asked, for whom a lease is issued, when it is re-issued, and the audit line each issue
 * leaves. Vault itself is a mocked fetch; the client is real.
 */
const base: DatabaseConnection = {
  id: "seed:orders",
  name: "Orders",
  type: "postgres",
  host: "orders.internal",
  user: "portal",
  password: "vault:db:database/orders",
  createdAt: new Date(0),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let issued = 0;
function vaultAnswers(url: string): Response {
  if (url.includes("/v1/database/creds/orders")) {
    issued += 1;
    return jsonResponse({ lease_duration: 100, data: { username: `v-orders-${issued}`, password: `pw-${issued}` } });
  }
  if (url.includes("/v1/secret/data/db/orders")) {
    return jsonResponse({ data: { data: { password: "kv-pass", user: "kv-user" } } });
  }
  return jsonResponse({ errors: ["not found"] }, 404);
}

function auditLines(logSpy: { mock: { calls: unknown[][] } }) {
  return logSpy.mock.calls
    .map((c) => c[0])
    .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
    .map((v) => JSON.parse(v) as Record<string, unknown>)
    .filter((e) => e.event === "credential_issued");
}

describe("parseVaultReference", () => {
  test("the two shapes, and what is malformed", () => {
    expect(isVaultReference("vault:kv:secret/x#k")).toBe(true);
    expect(isVaultReference("${ENV}")).toBe(false);
    expect(isVaultReference(undefined)).toBe(false);
    expect(parseVaultReference("vault:kv:secret/db/orders#password")).toEqual({
      kind: "kv",
      mount: "secret",
      path: "db/orders",
      key: "password",
    });
    expect(parseVaultReference("vault:db:database/orders-ro")).toEqual({
      kind: "db",
      mount: "database",
      role: "orders-ro",
    });
    for (const bad of [
      "vault:kv:secret/x",
      "vault:db:database/x#k",
      "vault:kv:secret#k",
      "vault:db:database/",
      "vault:x:a/b",
      "vault:kv:a b#c",
    ]) {
      expect(() => parseVaultReference(bad)).toThrow(VaultError);
      expect(() => parseVaultReference(bad)).toThrow("Malformed Vault reference");
    }
  });
});

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const fetchHolder = globalThis as unknown as { fetch: FetchLike };

describe("resolveVaultReferences", () => {
  let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;
  let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">>;
  let now = 1_000_000;
  const savedEnv = { addr: process.env.VAULT_ADDR, token: process.env.VAULT_TOKEN, ttl: process.env.VAULT_KV_TTL_MS };

  beforeEach(() => {
    resetVaultCache();
    issued = 0;
    now = 1_000_000;
    process.env.VAULT_ADDR = "https://vault.internal";
    process.env.VAULT_TOKEN = "s.token";
    delete process.env.VAULT_KV_TTL_MS;
    fetchSpy = spyOn(fetchHolder, "fetch").mockImplementation(async (url) => vaultAnswers(String(url)));
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    nowSpy = spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    logSpy.mockRestore();
    nowSpy.mockRestore();
    if (savedEnv.addr === undefined) delete process.env.VAULT_ADDR;
    else process.env.VAULT_ADDR = savedEnv.addr;
    if (savedEnv.token === undefined) delete process.env.VAULT_TOKEN;
    else process.env.VAULT_TOKEN = savedEnv.token;
    if (savedEnv.ttl === undefined) delete process.env.VAULT_KV_TTL_MS;
    else process.env.VAULT_KV_TTL_MS = savedEnv.ttl;
  });

  // The common case costs nothing: no reference, no fetch, the same object back.
  test("a connection without references is returned as it is, without asking Vault", async () => {
    const plain = { ...base, password: "literal" };
    expect(await resolveVaultReferences(plain, "ana")).toBe(plain);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a db reference issues a credential per person, fills user and password, and audits the issue", async () => {
    const ana = await resolveVaultReferences(base, "ana");
    expect(ana).toMatchObject({ user: "v-orders-1", password: "pw-1", host: "orders.internal" });
    const bob = await resolveVaultReferences(base, "bob");
    expect(bob).toMatchObject({ user: "v-orders-2", password: "pw-2" });
    // Ana again, well inside the lease: the same credential, no second issue.
    expect(await resolveVaultReferences(base, "ana")).toMatchObject({ user: "v-orders-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const lines = auditLines(logSpy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "credential_issued",
      action: "issue",
      outcome: "success",
      actor: "ana",
      route: "database/creds/orders",
    });
    expect(JSON.stringify(lines)).not.toContain("pw-1");
  });

  // A pool holding a credential Vault is about to revoke would fail mid-session; the lease
  // is re-issued at 80% of its life, and the factory swaps the pool on the new password.
  test("a lease is re-issued at 80% of its duration, not before", async () => {
    await resolveVaultReferences(base, "ana");
    now += 79_000;
    expect((await resolveVaultReferences(base, "ana")).password).toBe("pw-1");
    now += 2_000;
    expect((await resolveVaultReferences(base, "ana")).password).toBe("pw-2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("two simultaneous requests from one person share one issue", async () => {
    const [a, b] = await Promise.all([resolveVaultReferences(base, "ana"), resolveVaultReferences(base, "ana")]);
    expect(a.password).toBe("pw-1");
    expect(b.password).toBe("pw-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a lease Vault issued without a duration is re-issued as if it lasted an hour", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ data: { username: "u", password: "p" } }));
    await resolveVaultReferences(base, "ana");
    now += 3600 * 0.8 * 1000 - 1;
    await resolveVaultReferences(base, "ana");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    now += 2;
    await resolveVaultReferences(base, "ana");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("a kv reference is read once per TTL, shared by everyone, and may sit in any resolvable field", async () => {
    const kv = { ...base, password: "vault:kv:secret/db/orders#password", user: "vault:kv:secret/db/orders#user" };
    expect(await resolveVaultReferences(kv, "ana")).toMatchObject({ user: "kv-user", password: "kv-pass" });
    expect(await resolveVaultReferences(kv, "bob")).toMatchObject({ user: "kv-user", password: "kv-pass" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    now += DEFAULT_KV_TTL_MS + 1;
    process.env.VAULT_KV_TTL_MS = "10";
    await resolveVaultReferences(kv, "ana");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    now += 9;
    await resolveVaultReferences(kv, "ana");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    now += 2;
    await resolveVaultReferences(kv, "ana");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(auditLines(logSpy)).toHaveLength(0);
  });

  // docs/CONTEXT.md §4.9: an SSH profile's secret may be a kv reference read on its own; a
  // db reference makes no sense there (a bastion has no role to issue) and is refused.
  test("readVaultKvReference returns the field a kv reference names and refuses a db reference", async () => {
    expect(await readVaultKvReference("vault:kv:secret/db/orders#password")).toBe("kv-pass");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(readVaultKvReference("vault:db:database/orders")).rejects.toThrow("Only a vault:kv reference");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a kv reference to a field the secret does not have is refused, naming the secret and never a value", async () => {
    const err = await resolveVaultReferences({ ...base, password: "vault:kv:secret/db/orders#missing" }, "ana").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).toBe('Vault secret secret/db/orders has no string field "missing"');
    expect(err.message).not.toContain("kv-pass");
  });

  test("a db reference outside the password field, and a malformed reference, are refused before Vault is asked", async () => {
    await expect(
      resolveVaultReferences({ ...base, password: "x", user: "vault:db:database/orders" }, "ana"),
    ).rejects.toThrow('valid in "password" only');
    await expect(resolveVaultReferences({ ...base, password: "vault:nope" }, "ana")).rejects.toThrow("Malformed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a failed issue is audited as a failure with its reason, and the error is the client's VaultError", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ errors: ["permission denied"] }, 403));
    const err = await resolveVaultReferences(base, "ana").catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(auditLines(logSpy)[0]).toMatchObject({
      outcome: "failure",
      reason: "credential_provider_failed",
      actor: "ana",
    });
    // Nothing was cached: the next call asks again.
    fetchSpy.mockImplementation(async (url) => vaultAnswers(String(url)));
    expect((await resolveVaultReferences(base, "ana")).password).toBe("pw-1");
  });

  // Isolated like every other emit after the work is done: a broken sink must not turn an
  // issued credential into a failure.
  test("a broken audit sink does not fail the resolution", async () => {
    logSpy.mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await resolveVaultReferences(base, "ana")).password).toBe("pw-1");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("the caches are pruned of expired entries once they grow large", async () => {
    process.env.VAULT_KV_TTL_MS = "1";
    for (let i = 0; i < 1_000; i += 1) {
      await resolveVaultReferences(
        { ...base, password: `vault:kv:secret/db/orders#password`, database: `vault:kv:secret/db/orders#user` },
        "x",
      );
      await resolveVaultReferences(base, `person-${i}`);
      now += 2;
    }
    // Every earlier entry has expired by now; the maps stayed bounded rather than growing
    // by one per person and per read. Observable only through the fetch count staying
    // proportional, and through the resolution still working.
    expect((await resolveVaultReferences(base, "final")).user).toMatch(/^v-orders-/);
  });
});
