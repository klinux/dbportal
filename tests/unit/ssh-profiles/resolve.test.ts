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
    process.env.BASTION_PW = "pw-from-env";
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
