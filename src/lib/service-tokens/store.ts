import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SHARED_SERVICE_TOKENS_OWNER } from "@/lib/datasources/owner";
import { normalizeGroups } from "@/lib/access";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { ServiceIdentity, ServiceTokenRecord, ServiceTokenView } from "./types";

/**
 * Service tokens (docs/CONTEXT.md §4.10), kept in the server store under a reserved owner.
 * A secret is `dbp_` plus 32 characters of base64url from 24 random bytes; the store keeps
 * its SHA-256 and a display prefix, so a copy of the store is not a copy of the tokens.
 * Lookup hashes the presented secret and compares in constant time against every live
 * record: the list is small (tokens are per bot, not per person) and the comparison must
 * not leak which prefix matched.
 */
export class ServiceTokenError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

export const SECRET_PREFIX = "dbp_";
export const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLLECTION = "service_tokens" as const;
const CACHE_TTL_MS = 5_000;
const STORE_UNAVAILABLE = "Service tokens need server storage: set STORAGE_PROVIDER to sqlite or postgres";
const ACTOR_PREFIX = "svc:";

let cache: { at: number; records: ServiceTokenRecord[] } | null = null;

/** Tests only. */
export function resetServiceTokenCache(): void {
  cache = null;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The audit actor of a token: `svc:<name>`, so a reader tells a bot from a person at a glance. */
export function actorOf(token: Pick<ServiceTokenRecord, "name">): string {
  return `${ACTOR_PREFIX}${token.name}`;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new ServiceTokenError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readAll(): Promise<ServiceTokenRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_SERVICE_TOKENS_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: ServiceTokenRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_SERVICE_TOKENS_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

export function toServiceTokenView(record: ServiceTokenRecord): ServiceTokenView {
  const { secretHash, ...view } = record;
  void secretHash;
  return view;
}

export async function listServiceTokens(): Promise<ServiceTokenView[]> {
  return (await readAll()).map(toServiceTokenView);
}

function stringList(value: unknown, field: string, shape?: RegExp): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new ServiceTokenError(`${field} must be a list of strings`, 400);
  const list = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
  if (shape && list.some((v) => !shape.test(v)))
    throw new ServiceTokenError(`${field} may only hold ids of the form [a-z0-9-]`, 400);
  return list;
}

/** Create a token; the secret is in the return value and nowhere else, ever. */
export async function createServiceToken(
  input: unknown,
  actor: string,
): Promise<{ record: ServiceTokenRecord; secret: string }> {
  if (typeof input !== "object" || input === null) throw new ServiceTokenError("Request body must be an object", 400);
  const body = input as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME_SHAPE.test(name)) throw new ServiceTokenError("name must match [a-z0-9][a-z0-9-]{0,63}", 400);
  const role = body.role === undefined ? "user" : body.role;
  if (role !== "user" && role !== "admin") throw new ServiceTokenError('role must be "user" or "admin"', 400);
  const groups = normalizeGroups(stringList(body.groups, "groups"));
  const datasources = stringList(body.datasources, "datasources", NAME_SHAPE);
  const requireApproval = body.requireApproval === undefined ? false : body.requireApproval === true;
  const trustedApprovals = body.trustedApprovals === true;
  const records = await readAll();
  if (records.some((r) => r.name === name && !r.revokedAt))
    throw new ServiceTokenError(`A live service token named "${name}" already exists`, 409);
  const secret = `${SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
  const record: ServiceTokenRecord = {
    id: randomUUID(),
    name,
    role,
    ...(groups.length > 0 ? { groups } : {}),
    ...(datasources.length > 0 ? { datasources } : {}),
    requireApproval,
    ...(trustedApprovals ? { trustedApprovals } : {}),
    secretHash: hashSecret(secret),
    prefix: secret.slice(0, SECRET_PREFIX.length + 6),
    createdAt: new Date().toISOString(),
    createdBy: actor,
  };
  await writeAll([...records, record]);
  return { record, secret };
}

/** Revoke: the record stays, so the audit trail keeps resolving `svc:<name>`; the secret stops working at once. */
export async function revokeServiceToken(id: string, actor: string): Promise<ServiceTokenRecord> {
  const records = await readAll();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new ServiceTokenError(`Service token "${id}" not found`, 404);
  if (existing.revokedAt) throw new ServiceTokenError(`Service token "${existing.name}" is already revoked`, 409);
  const revoked: ServiceTokenRecord = { ...existing, revokedAt: new Date().toISOString(), revokedBy: actor };
  await writeAll(records.map((r) => (r.id === id ? revoked : r)));
  return revoked;
}

/**
 * The identity behind a presented secret, or null. Every live record is compared, in
 * constant time each, so neither the count nor the position of a match shows in timing.
 */
export async function authenticateServiceToken(secret: string): Promise<ServiceIdentity | null> {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const presented = Buffer.from(hashSecret(secret), "hex");
  let match: ServiceTokenRecord | null = null;
  for (const record of await readAll()) {
    const stored = Buffer.from(record.secretHash, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && !record.revokedAt) match = record;
  }
  if (!match) return null;
  return {
    token: match,
    session: { role: match.role, username: actorOf(match), ...(match.groups ? { groups: match.groups } : {}) },
  };
}

/** The live token behind an audit actor (`svc:<name>`), for running a request it queued earlier. */
export async function findServiceTokenByActor(actor: string): Promise<ServiceIdentity | null> {
  if (!actor.startsWith(ACTOR_PREFIX)) return null;
  const name = actor.slice(ACTOR_PREFIX.length);
  const match = (await readAll()).find((r) => r.name === name && !r.revokedAt);
  if (!match) return null;
  return {
    token: match,
    session: { role: match.role, username: actor, ...(match.groups ? { groups: match.groups } : {}) },
  };
}

/**
 * Best effort: the last-used stamp is a convenience for the operator, never worth failing a
 * request over, and worth one write a minute per token rather than one per call.
 */
export const TOUCH_INTERVAL_MS = 60_000;
export async function touchServiceToken(id: string): Promise<void> {
  const records = await readAll();
  const current = records.find((r) => r.id === id);
  if (!current) return;
  if (current.lastUsedAt && Date.now() - Date.parse(current.lastUsedAt) < TOUCH_INTERVAL_MS) return;
  const at = new Date().toISOString();
  await writeAll(records.map((r) => (r.id === id ? { ...r, lastUsedAt: at } : r)));
}
