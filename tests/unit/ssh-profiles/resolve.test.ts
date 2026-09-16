import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The resolver on its own (docs/CONTEXT.md §4.9): what tunnel a profile becomes, which of
 * its secrets are read from where, and what a datasource naming no profile gets back. The
 * store and Vault are mocked; tests/unit/ssh-profiles/resolve-connection.test.ts proves the
 * real path through the seed file.
 */
let known: Record<string, unknown> = {};
mock.module("@/lib/ssh-profiles/store", () => ({
  findSshProfile: async (id: string) => known[id] ?? null,
}));
// The person's own identity (§4.9), when they have one.
let identity: { username: string; privateKey: string; passphrase?: string; updatedAt: string } | null = null;
const identityRead = mock(async (_owner: string) => identity);
mock.module("@/lib/ssh-identity/store", () => ({ getSshIdentity: identityRead }));
const kvRead = mock(async (ref: string) => `from-vault:${ref}`);
mock.module("@/lib/vault/credentials", () => ({
  isVaultReference: (v: unknown) => typeof v === "string" && v.startsWith("vault:"),
  readVaultKvReference: (ref: string) => kvRead(ref),
}));

const { applySshProfile, tunnelFromProfile, SshProfileResolutionError } = await import("@/lib/ssh-profiles/resolve");

const passwordProfile = {
  id: "pw",
  name: "Password bastion",
  host: "b.internal",
  port: 22,
  username: "ops",
  authMethod: "password" as const,
  password: "${BASTION_PW}",
};
const keyProfile = {
  id: "key",
  name: "Key bastion",
  host: "b.internal",
  port: 2222,
  username: "ops",
  authMethod: "privateKey" as const,
  privateKey: "vault:kv:secret/bastion#key",
  passphrase: "literal-pass",
  hostKeyFingerprint: "SHA256:abc",
};
const conn: DatabaseConnection = { id: "c", name: "Orders", type: "postgres", createdAt: new Date(0) };

describe("tunnelFromProfile", () => {
  beforeEach(() => {
    kvRead.mockClear();
    identityRead.mockClear();
    identity = null;
    process.env.BASTION_PW = "pw-from-env";
  });

  // §4.9: a profile that opens the bastion as the person uses their user and key with the
  // profile's host, port and pin; without an identity of their own, or on a profile that does
  // not ask, the profile's credential stands - nobody without a key is locked out.
  test("a personal-identity profile opens as the person when they have an identity, and as the profile otherwise", async () => {
    const personal = { ...keyProfile, id: "personal", personalIdentity: true };
    known = { personal, key: keyProfile };
    identity = { username: "ana_example_com", privateKey: "ANA-KEY", passphrase: "ana-pass", updatedAt: "x" };
    const asAna = await applySshProfile({ ...conn, sshProfile: "personal" }, "ana@example.test");
    expect(asAna.sshTunnel).toEqual({
      enabled: true,
      host: "b.internal",
      port: 2222,
      username: "ana_example_com",
      authMethod: "privateKey",
      privateKey: "ANA-KEY",
      passphrase: "ana-pass",
      hostKeyFingerprint: "SHA256:abc",
    });
    expect(identityRead).toHaveBeenCalledWith("ana@example.test");
    // No identity: the profile's own credential, read as before.
    identity = null;
    const asBob = await applySshProfile({ ...conn, sshProfile: "personal" }, "bob@example.test");
    expect(asBob.sshTunnel?.username).toBe("ops");
    expect(asBob.sshTunnel?.privateKey).toBe("from-vault:vault:kv:secret/bastion#key");
    // A profile that does not ask never reads the identity, even for someone who has one.
    identity = { username: "ana_example_com", privateKey: "ANA-KEY", updatedAt: "x" };
    identityRead.mockClear();
    const plain = await applySshProfile({ ...conn, sshProfile: "key" }, "ana@example.test");
    expect(plain.sshTunnel?.username).toBe("ops");
    expect(identityRead).not.toHaveBeenCalled();
    // Nobody named (no subject): the profile's credential.
    const nobody = await applySshProfile({ ...conn, sshProfile: "personal" });
    expect(nobody.sshTunnel?.username).toBe("ops");
    // A key without a passphrase carries none.
    expect((await tunnelFromProfile(personal, identity)).passphrase).toBeUndefined();
  });

  test("a password profile carries the resolved password and nothing key-shaped", async () => {
    const tunnel = await tunnelFromProfile(passwordProfile);
    expect(tunnel).toEqual({
      enabled: true,
      host: "b.internal",
      port: 22,
      username: "ops",
      authMethod: "password",
      password: "pw-from-env",
    });
    expect(kvRead).not.toHaveBeenCalled();
  });

  test("a key profile reads a vault reference, keeps a literal as it is, and pins the host key", async () => {
    const tunnel = await tunnelFromProfile(keyProfile);
    expect(tunnel).toMatchObject({
      authMethod: "privateKey",
      privateKey: "from-vault:vault:kv:secret/bastion#key",
      passphrase: "literal-pass",
      hostKeyFingerprint: "SHA256:abc",
      port: 2222,
    });
    expect(tunnel).not.toHaveProperty("password");
    expect(kvRead).toHaveBeenCalledWith("vault:kv:secret/bastion#key");
  });

  test("a secret left blank stays undefined rather than becoming an empty string the driver would send", async () => {
    const tunnel = await tunnelFromProfile({ ...keyProfile, passphrase: "" });
    expect(tunnel.passphrase).toBeUndefined();
  });

  test("an unset ${VAR} is a 400 that names the variable, the profile and the field", async () => {
    delete process.env.BASTION_PW;
    const err = await tunnelFromProfile(passwordProfile).catch((e) => e);
    expect(err).toBeInstanceOf(SshProfileResolutionError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(
      'Environment variable BASTION_PW is not defined (required by SSH profile "pw" field "password")',
    );
  });
});

describe("applySshProfile", () => {
  beforeEach(() => {
    known = { pw: passwordProfile };
    process.env.BASTION_PW = "pw-from-env";
  });

  test("a connection naming no profile is returned as it is", async () => {
    expect(await applySshProfile(conn)).toBe(conn);
  });

  test("a connection naming a known profile gets the tunnel, and keeps the name it used", async () => {
    const resolved = await applySshProfile({ ...conn, sshProfile: "pw" });
    expect(resolved.sshProfile).toBe("pw");
    expect(resolved.sshTunnel?.password).toBe("pw-from-env");
  });

  test("an unknown profile is a 400 that names the datasource and the profile", async () => {
    const err = await applySshProfile({ ...conn, sshProfile: "ghost" }).catch((e) => e);
    expect(err).toBeInstanceOf(SshProfileResolutionError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Datasource "Orders" names an SSH profile "ghost" that does not exist');
  });
});
