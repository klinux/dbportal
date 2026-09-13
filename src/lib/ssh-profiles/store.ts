import { SHARED_SSH_PROFILES_OWNER } from "@/lib/datasources/owner";
import { listSharedDatasources } from "@/lib/datasources/store";
import { loadConfig } from "@/lib/seed/config-loader";
import { SshProfileSchema, type SshProfile } from "@/lib/seed/types";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import { isVaultReference } from "@/lib/vault/credentials";
import type { SshProfileRecord, SshProfileView } from "./types";

/**
 * SSH profiles (docs/CONTEXT.md §4.9): a bastion declared once and referenced by any number
 * of datasources through `sshProfile: "<id>"`. Two sources, one list: the seed file's
 * `sshProfiles` (read-only from here) and the records an administrator saved through the
 * admin API, kept in the server store under a reserved owner where the encrypting layer
 * seals the password, the private key and the passphrase exactly as it seals a tunnel's.
 *
 * A profile that a datasource still names cannot be deleted: the datasource would open
 * with a tunnel the server can no longer build.
 */
export class SshProfileError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SshProfileError";
  }
}

const COLLECTION = "ssh_profiles" as const;
const CACHE_TTL_MS = 5_000;
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const STORE_UNAVAILABLE = "SSH profiles need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: SshProfileRecord[] } | null = null;

/** Tests only: forget what this process has read. */
export function resetSshProfileCache(): void {
  cache = null;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new SshProfileError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readStored(): Promise<SshProfileRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_SSH_PROFILES_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: SshProfileRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_SSH_PROFILES_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

async function declared(): Promise<SshProfile[]> {
  const config = await loadConfig();
  return config?.sshProfiles ?? [];
}

/** Every profile with its secrets, for the server's own use; the seed file's first. */
export async function listSshProfiles(): Promise<{ profile: SshProfile; source: "config" | "store" }[]> {
  const fromConfig = await declared();
  const ids = new Set(fromConfig.map((p) => p.id));
  const stored = (await readStored()).filter((p) => !ids.has(p.id));
  return [
    ...fromConfig.map((profile) => ({ profile, source: "config" as const })),
    ...stored.map((profile) => ({ profile, source: "store" as const })),
  ];
}

export async function findSshProfile(id: string): Promise<SshProfile | null> {
  return (await listSshProfiles()).find((entry) => entry.profile.id === id)?.profile ?? null;
}

function validate(input: unknown): SshProfile {
  const result = SshProfileSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new SshProfileError(`Invalid SSH profile: ${issues}`, 400);
  }
  return result.data;
}

export async function createSshProfile(input: unknown, actor: string): Promise<SshProfileRecord> {
  const data = validate(input);
  if ((await declared()).some((p) => p.id === data.id)) {
    throw new SshProfileError(`SSH profile "${data.id}" is declared in the seed file; edit it there`, 409);
  }
  const records = await readStored();
  if (records.some((r) => r.id === data.id))
    throw new SshProfileError(`An SSH profile with id "${data.id}" already exists`, 409);
  const now = new Date().toISOString();
  const record: SshProfileRecord = { ...data, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor };
  await writeAll([...records, record]);
  return record;
}

/** Replace a profile. A secret left out or blank is kept: the API never returns one, so a round-tripped edit must not wipe it. */
export async function updateSshProfile(id: string, input: unknown, actor: string): Promise<SshProfileRecord> {
  const candidate = typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>), id } : input;
  const data = validate(candidate);
  const records = await readStored();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new SshProfileError(`SSH profile "${id}" not found`, 404);
  const record: SshProfileRecord = {
    ...data,
    password: data.password || existing.password,
    privateKey: data.privateKey || existing.privateKey,
    passphrase: data.passphrase || existing.passphrase,
    createdAt: existing.createdAt,
    createdBy: existing.createdBy,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  await writeAll(records.map((r) => (r.id === id ? record : r)));
  return record;
}

/** The datasources, from the seed file and the store, that name this profile. */
export async function datasourcesUsing(id: string): Promise<string[]> {
  const config = await loadConfig();
  const fromConfig = (config?.connections ?? []).filter((c) => c.sshProfile === id).map((c) => c.id);
  const fromStore = (await listSharedDatasources()).filter((c) => c.sshProfile === id).map((c) => c.id);
  return [...fromConfig, ...fromStore];
}

export async function deleteSshProfile(id: string): Promise<SshProfileRecord> {
  const records = await readStored();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new SshProfileError(`SSH profile "${id}" not found`, 404);
  const users = await datasourcesUsing(id);
  if (users.length > 0) {
    throw new SshProfileError(
      `SSH profile "${id}" is used by ${users.join(", ")}; point those datasources elsewhere first`,
      409,
    );
  }
  await writeAll(records.filter((r) => r.id !== id));
  return existing;
}

function refOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ENV_REFERENCE.test(value) || isVaultReference(value) ? value : undefined;
}

/** What leaves the server: the profile with every secret replaced by a fact about it. */
export function toSshProfileView(profile: SshProfile | SshProfileRecord, source: "config" | "store"): SshProfileView {
  const { password, privateKey, passphrase, ...rest } = profile;
  const stamps =
    "updatedAt" in profile
      ? { createdAt: profile.createdAt, updatedAt: profile.updatedAt, updatedBy: profile.updatedBy }
      : {};
  return {
    ...rest,
    ...stamps,
    source,
    hasPassword: !!password,
    hasPrivateKey: !!privateKey,
    hasPassphrase: !!passphrase,
    ...(refOf(password) ? { passwordRef: password } : {}),
    ...(refOf(privateKey) ? { privateKeyRef: privateKey } : {}),
  };
}

export async function listSshProfileViews(): Promise<SshProfileView[]> {
  return (await listSshProfiles()).map(({ profile, source }) => toSshProfileView(profile, source));
}
