import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { issueDatabaseCredentials, readKvSecret, VaultError } from "./client";

/**
 * Credential references a datasource may carry instead of a value (docs/CONTEXT.md §4.5),
 * resolved on the server when the datasource is opened - the value never sits in the seed
 * file, the store, or the browser:
 *
 * - `vault:kv:<mount>/<path>#<key>` - one field of a KV v2 secret. Static; read once and
 *   kept for VAULT_KV_TTL_MS (default five minutes), then read again.
 * - `vault:db:<mount>/<role>` - a credential the database secrets engine ISSUES, with a
 *   lease. Valid in `password` only, and it fills `user` too. Issued per person, so the
 *   database sees one user per person, and re-issued at 80% of the lease so a pool never
 *   holds a credential Vault is about to revoke.
 *
 * The cache lives on globalThis: Next.js gives each route its own module instance, and a
 * lease issued for one route must be the one every route uses.
 */
const REFERENCE = /^vault:(kv|db):([A-Za-z0-9_\-./]+?)(?:#([A-Za-z0-9_\-.]+))?$/;

export type VaultReference =
  | { kind: "kv"; mount: string; path: string; key: string }
  | { kind: "db"; mount: string; role: string };

export function isVaultReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("vault:");
}

/** A parsed reference, or a VaultError that says what is wrong with it. Never a value. */
export function parseVaultReference(value: string): VaultReference {
  const match = value.match(REFERENCE);
  if (!match)
    throw new VaultError(
      `Malformed Vault reference: expected vault:kv:<mount>/<path>#<key> or vault:db:<mount>/<role>`,
    );
  const [, kind, location, key] = match;
  const slash = location.indexOf("/");
  if (slash <= 0 || slash === location.length - 1) {
    throw new VaultError(`Malformed Vault reference: "${location}" needs a mount and a path`);
  }
  const mount = location.slice(0, slash);
  const rest = location.slice(slash + 1);
  if (kind === "kv") {
    if (!key) throw new VaultError(`Malformed Vault reference: a kv reference needs #<key>`);
    return { kind: "kv", mount, path: rest, key };
  }
  if (key) throw new VaultError(`Malformed Vault reference: a db reference takes no #<key>`);
  return { kind: "db", mount, role: rest };
}

const KV_FIELDS = ["password", "connectionString", "user", "host", "database"] as const;
export const DEFAULT_KV_TTL_MS = 5 * 60_000;
/** A lease Vault issued without a duration is treated as an hour: re-issued well before that. */
const ASSUMED_LEASE_S = 3600;
const RENEW_AT = 0.8;
const PRUNE_ABOVE = 1_000;

interface CachedSecret {
  data: Record<string, unknown>;
  expiresAt: number;
}
interface CachedLease {
  username: string;
  password: string;
  expiresAt: number;
  renewAt: number;
}
interface VaultCache {
  kv: Map<string, CachedSecret>;
  db: Map<string, CachedLease>;
  pending: Map<string, Promise<CachedLease>>;
}

const CACHE_KEY = Symbol.for("dbportal.vault-cache");

function cache(): VaultCache {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: VaultCache };
  holder[CACHE_KEY] ??= { kv: new Map(), db: new Map(), pending: new Map() };
  return holder[CACHE_KEY];
}

/** Tests only: forget every secret and lease this process holds. */
export function resetVaultCache(): void {
  const c = cache();
  c.kv.clear();
  c.db.clear();
  c.pending.clear();
}

function kvTtlMs(): number {
  const ttl = Number(process.env.VAULT_KV_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_KV_TTL_MS;
}

function prune<T extends { expiresAt: number }>(map: Map<string, T>, now: number): void {
  if (map.size < PRUNE_ABOVE) return;
  for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
}

/** One read per secret, whichever of its fields the datasource references. */
async function kvValue(ref: Extract<VaultReference, { kind: "kv" }>, now: number): Promise<string> {
  const key = `${ref.mount}/${ref.path}`;
  const hit = cache().kv.get(key);
  let data = hit && hit.expiresAt > now ? hit.data : undefined;
  if (!data) {
    data = await readKvSecret(ref.mount, ref.path);
    prune(cache().kv, now);
    cache().kv.set(key, { data, expiresAt: now + kvTtlMs() });
  }
  const value = data[ref.key];
  if (typeof value !== "string") throw new VaultError(`Vault secret ${key} has no string field "${ref.key}"`);
  return value;
}

function recordIssue(conn: DatabaseConnection, subject: string, target: string, ok: boolean): void {
  // Isolated like every other emit on a path that already did its work: a broken audit sink
  // must not turn an issued credential into a failed one.
  try {
    emitAuditEvent({
      type: "credential_issued",
      action: "issue",
      target,
      connectionName: conn.name,
      user: subject,
      result: ok ? "success" : "failure",
      ...(ok ? {} : { reason: "credential_provider_failed" }),
    });
  } catch (auditError) {
    logger.error("Failed to record credential_issued audit event", auditError, { route: "vault/credentials" });
  }
}

async function issue(
  ref: Extract<VaultReference, { kind: "db" }>,
  conn: DatabaseConnection,
  subject: string,
  now: number,
): Promise<CachedLease> {
  const target = `${ref.mount}/creds/${ref.role}`;
  try {
    const issued = await issueDatabaseCredentials(ref.mount, ref.role);
    const leaseS = issued.leaseDurationS || ASSUMED_LEASE_S;
    recordIssue(conn, subject, target, true);
    return {
      username: issued.username,
      password: issued.password,
      expiresAt: now + leaseS * 1000,
      renewAt: now + leaseS * RENEW_AT * 1000,
    };
  } catch (error) {
    recordIssue(conn, subject, target, false);
    throw error;
  }
}

async function leaseFor(
  ref: Extract<VaultReference, { kind: "db" }>,
  conn: DatabaseConnection,
  subject: string,
  now: number,
): Promise<CachedLease> {
  const key = `${ref.mount}/${ref.role}::${subject}`;
  const c = cache();
  const hit = c.db.get(key);
  if (hit && hit.renewAt > now) return hit;
  // Two requests from the same person in the same instant get one lease, not two.
  const inFlight = c.pending.get(key);
  if (inFlight) return inFlight;
  const pending = issue(ref, conn, subject, now)
    .then((lease) => {
      prune(c.db, now);
      c.db.set(key, lease);
      return lease;
    })
    .finally(() => c.pending.delete(key));
  c.pending.set(key, pending);
  return pending;
}

/**
 * One `vault:kv:` reference read on its own - what an SSH profile's secret may be (§4.9). A
 * db reference has no meaning outside a datasource's own credential and is refused.
 */
export async function readVaultKvReference(value: string): Promise<string> {
  const ref = parseVaultReference(value);
  if (ref.kind !== "kv") throw new VaultError("Only a vault:kv reference may be used here");
  return kvValue(ref, Date.now());
}

/**
 * The connection with every Vault reference replaced by what Vault holds, for `subject`
 * (the person the datasource is opened for). A connection without references is returned
 * as it is, without a promise worth waiting on. Throws VaultError - the caller decides
 * what the client learns, which is never the message.
 */
export async function resolveVaultReferences<T extends DatabaseConnection>(conn: T, subject: string): Promise<T> {
  if (!KV_FIELDS.some((field) => isVaultReference(conn[field]))) return conn;
  const now = Date.now();
  const resolved: Record<string, unknown> = { ...(conn as Record<string, unknown>) };
  for (const field of KV_FIELDS) {
    const value = conn[field];
    if (!isVaultReference(value)) continue;
    const ref = parseVaultReference(value);
    if (ref.kind === "kv") {
      resolved[field] = await kvValue(ref, now);
      continue;
    }
    if (field !== "password") throw new VaultError(`A vault:db reference is valid in "password" only, not "${field}"`);
    const lease = await leaseFor(ref, conn, subject, now);
    resolved.user = lease.username;
    resolved.password = lease.password;
  }
  return resolved as T;
}
