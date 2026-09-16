import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import path from "path";

/**
 * SSH profiles at the moment a datasource is opened (docs/CONTEXT.md §4.9): the seed file
 * declares the bastion once, the datasource names it, and `resolveConnection` hands the
 * route a connection whose `sshTunnel` carries the profile's resolved secrets - a `${VAR}`
 * from the environment, a `vault:kv` reference from Vault. The config loader is real and
 * reads its own fixture; Vault is a mocked fetch.
 */
const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "ssh-profiles-config.yaml");
process.env.SHARED_PG_PASS = "shared-secret";
process.env.FIXTURE_BASTION_KEY = "-----BEGIN KEY-----";
process.env.FIXTURE_BASTION_PASS = "key-pass";

import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { resetCache } from "@/lib/seed/config-loader";
import { resetVaultCache } from "@/lib/vault/credentials";

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const fetchHolder = globalThis as unknown as { fetch: FetchLike };
const session = { role: "user" as const, username: "ana" };

describe("resolveConnection with SSH profiles", () => {
  beforeEach(() => {
    resetCache();
    resetVaultCache();
  });

  it("builds the tunnel from the named profile with its ${VAR} secrets, and never stores the key on the datasource", async () => {
    const resolved = await resolveConnection({ connectionId: "seed:behind-bastion" }, session);
    expect(resolved.sshProfile).toBe("fixture-bastion");
    expect(resolved.sshTunnel).toEqual({
      enabled: true,
      host: "bastion.internal",
      port: 22,
      username: "portal",
      authMethod: "privateKey",
      privateKey: "-----BEGIN KEY-----",
      passphrase: "key-pass",
      hostKeyFingerprint: "SHA256:fixture",
    });
    expect(resolved.password).toBe("shared-secret");
  });

  it("leaves a datasource that names no profile alone", async () => {
    const resolved = await resolveConnection({ connectionId: "seed:direct" }, session);
    expect(resolved.sshTunnel).toBeUndefined();
  });

  // A name the file does not declare is the declaration's mistake: a 400 that names it.
  it("refuses a datasource that names an unknown profile with 400, naming both", async () => {
    const err = await resolveConnection({ connectionId: "seed:orphan-bastion" }, session).catch((e) => e);
    expect(err).toBeInstanceOf(SeedConnectionError);
    expect((err as SeedConnectionError).statusCode).toBe(400);
    expect((err as SeedConnectionError).message).toContain('"nobody"');
    expect((err as SeedConnectionError).message).toContain("Names a missing profile");
  });

  it("refuses a profile whose ${VAR} is unset with 400 that names the variable, not a value", async () => {
    const saved = process.env.FIXTURE_BASTION_PASS;
    delete process.env.FIXTURE_BASTION_PASS;
    try {
      const err = await resolveConnection({ connectionId: "seed:behind-bastion" }, session).catch((e) => e);
      expect((err as SeedConnectionError).statusCode).toBe(400);
      expect((err as SeedConnectionError).message).toContain("FIXTURE_BASTION_PASS");
      expect((err as SeedConnectionError).message).toContain('"fixture-bastion"');
    } finally {
      process.env.FIXTURE_BASTION_PASS = saved;
    }
  });

  describe("a profile whose secret lives in Vault", () => {
    const savedAddr = process.env.VAULT_ADDR;
    const savedToken = process.env.VAULT_TOKEN;
    const savedRenew = process.env.VAULT_TOKEN_RENEW;
    let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
    let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

    beforeEach(() => {
      process.env.VAULT_ADDR = "https://vault.internal";
      process.env.VAULT_TOKEN = "s.token";
      // The token's self-renewal is the client's own test; off here so every request counted is a secret's.
      process.env.VAULT_TOKEN_RENEW = "off";
      fetchSpy = spyOn(fetchHolder, "fetch").mockImplementation(
        async () => new Response(JSON.stringify({ data: { data: { password: "bastion-pw" } } }), { status: 200 }),
      );
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
      if (savedAddr === undefined) delete process.env.VAULT_ADDR;
      else process.env.VAULT_ADDR = savedAddr;
      if (savedToken === undefined) delete process.env.VAULT_TOKEN;
      else process.env.VAULT_TOKEN = savedToken;
      if (savedRenew === undefined) delete process.env.VAULT_TOKEN_RENEW;
      else process.env.VAULT_TOKEN_RENEW = savedRenew;
    });

    it("reads the kv reference and puts the value in the tunnel", async () => {
      const resolved = await resolveConnection({ connectionId: "seed:vault-bastion-db" }, session);
      expect(resolved.sshTunnel).toMatchObject({ port: 2222, authMethod: "password", password: "bastion-pw" });
      expect(String((fetchSpy.mock.calls[0] as [string])[0])).toContain("/v1/secret/data/bastion");
    });

    // The client learns that the profile could not be resolved, never Vault's words.
    it("answers 503 without Vault's words when the secret cannot be read", async () => {
      fetchSpy.mockImplementation(
        async () => new Response(JSON.stringify({ errors: ["permission denied"] }), { status: 403 }),
      );
      const err = await resolveConnection({ connectionId: "seed:vault-bastion-db" }, session).catch((e) => e);
      expect((err as SeedConnectionError).statusCode).toBe(503);
      expect((err as SeedConnectionError).message).toBe(
        'The SSH profile of "Behind the Vault bastion" could not be resolved from the secrets manager',
      );
      expect((err as SeedConnectionError).message).not.toContain("permission denied");
    });
  });
});
