import type { SshProfile } from "@/lib/seed/types";
import type { DatabaseConnection, SSHTunnelConfig } from "@/lib/types";
import { getSshIdentity } from "@/lib/ssh-identity/store";
import type { SshIdentityRecord } from "@/lib/storage/types";
import { isVaultReference, readVaultKvReference } from "@/lib/vault/credentials";
import { findSshProfile } from "./store";

/**
 * A datasource that names an SSH profile (docs/CONTEXT.md §4.9) gets its tunnel built here,
 * when it is opened: the profile's secrets may be values, `${ENV_VAR}` references or
 * `vault:kv:` references, resolved on the server and never stored on the datasource.
 */
export class SshProfileResolutionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SshProfileResolutionError";
  }
}

const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

async function secret(value: string | undefined, field: string, profileId: string): Promise<string | undefined> {
  if (value === undefined || value === "") return undefined;
  const env = value.match(ENV_REFERENCE);
  if (env) {
    const resolved = process.env[env[1]];
    if (resolved === undefined) {
      throw new SshProfileResolutionError(
        `Environment variable ${env[1]} is not defined (required by SSH profile "${profileId}" field "${field}")`,
        400,
      );
    }
    return resolved;
  }
  if (isVaultReference(value)) return readVaultKvReference(value);
  return value;
}

/**
 * The tunnel a profile describes, with its secrets resolved - or, when the profile opens the
 * bastion as the person and one is given, the bastion from the profile and the user and key
 * from the person's own identity (§4.9).
 */
export async function tunnelFromProfile(profile: SshProfile, identity?: SshIdentityRecord | null): Promise<SSHTunnelConfig> {
  if (profile.personalIdentity && identity) {
    return {
      enabled: true,
      host: profile.host,
      port: profile.port,
      username: identity.username,
      authMethod: "privateKey",
      privateKey: identity.privateKey,
      ...(identity.passphrase ? { passphrase: identity.passphrase } : {}),
      ...(profile.hostKeyFingerprint ? { hostKeyFingerprint: profile.hostKeyFingerprint } : {}),
    };
  }
  return {
    enabled: true,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    ...(profile.authMethod === "password" ? { password: await secret(profile.password, "password", profile.id) } : {}),
    ...(profile.authMethod === "privateKey"
      ? {
          privateKey: await secret(profile.privateKey, "privateKey", profile.id),
          passphrase: await secret(profile.passphrase, "passphrase", profile.id),
        }
      : {}),
    ...(profile.hostKeyFingerprint ? { hostKeyFingerprint: profile.hostKeyFingerprint } : {}),
  };
}

/**
 * The connection with `sshTunnel` built from the profile it names; unchanged when it names
 * none. A name the server does not know is the declaration's fault: a 400 that names it.
 */
export async function applySshProfile<T extends DatabaseConnection>(conn: T, subject?: string): Promise<T> {
  if (!conn.sshProfile) return conn;
  const profile = await findSshProfile(conn.sshProfile);
  if (!profile) {
    throw new SshProfileResolutionError(
      `Datasource "${conn.name}" names an SSH profile "${conn.sshProfile}" that does not exist`,
      400,
    );
  }
  // The person's own identity, when the profile asks for it and they have one; the
  // profile's credential otherwise, so nobody without a key is locked out.
  const identity = profile.personalIdentity && subject ? await getSshIdentity(subject) : null;
  return { ...conn, sshTunnel: await tunnelFromProfile(profile, identity) };
}
