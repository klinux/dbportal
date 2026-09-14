import { type AccessSession, matchesAccess, memberPrincipalsOf } from "@/lib/access";
import { SHARED_ROLES_OWNER } from "@/lib/datasources/owner";
import { logger } from "@/lib/logger";
import { loadConfig } from "@/lib/seed/config-loader";
import { NamedRoleSchema, type NamedRole } from "@/lib/seed/types";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Named roles (docs/CONTEXT.md §4.19): an id declared once - `oncall`, `reviewer` - with
 * who is in it (a portal role, an identity provider's group, a person by username), that
 * every datasource list (`roles`, `writeRoles`, `approverRoles`) refers to as `role:<id>`.
 * A reviewer who does not administer, an on-call who may write, named once instead of a
 * group repeated on every datasource.
 *
 * Declared in the seed file (`namedRoles:`, read-only here) or by an administrator on the
 * Security page, kept in the server store under a reserved owner. Resolved when a session
 * is read, from a list cached for a few seconds, so a change applies on the next request
 * and no token has to expire first. A role is never a member of a role: one lookup.
 */

export type { NamedRole };

export interface NamedRoleRecord extends NamedRole {
  createdAt: string;
  createdBy: string;
}

export type NamedRoleSource = "config" | "store";

export class NamedRoleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "NamedRoleError";
  }
}

const COLLECTION = "named_roles" as const;
const CACHE_TTL_MS = 5_000;
const STORE_UNAVAILABLE = "Named roles need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: NamedRoleRecord[] } | null = null;

/** Tests only. */
export function resetNamedRolesCache(): void {
  cache = null;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new NamedRoleError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readStored(): Promise<NamedRoleRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_ROLES_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: NamedRoleRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_ROLES_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

async function declared(): Promise<NamedRole[]> {
  const config = await loadConfig();
  return config?.namedRoles ?? [];
}

/** Every named role with where it came from; the seed file's first. */
export async function listNamedRoles(): Promise<{ role: NamedRole | NamedRoleRecord; source: NamedRoleSource }[]> {
  const fromConfig = await declared();
  const ids = new Set(fromConfig.map((r) => r.id));
  const stored = (await readStored()).filter((r) => !ids.has(r.id));
  return [
    ...fromConfig.map((role) => ({ role, source: "config" as const })),
    ...stored.map((role) => ({ role, source: "store" as const })),
  ];
}

/** The ids of the named roles this session is in, judged on its role, groups and username. */
export async function namedRolesOf(session: AccessSession): Promise<string[]> {
  const principals = memberPrincipalsOf(session);
  return (await listNamedRoles()).filter((e) => matchesAccess(e.role.members, principals)).map((e) => e.role.id);
}

/**
 * The session with its named roles filled in. A list that cannot be read grants nothing
 * (the failure is logged, the request goes on with the token's own principals): a store
 * outage must not open a datasource, and must not close the portal either.
 */
export async function withNamedRoles<S extends AccessSession>(session: S): Promise<S> {
  try {
    const namedRoles = await namedRolesOf(session);
    return namedRoles.length > 0 ? { ...session, namedRoles } : session;
  } catch (error) {
    logger.error("Named roles could not be resolved; the session keeps its own principals", error, {
      route: "roles/store",
    });
    return session;
  }
}

function validate(input: unknown): NamedRole {
  const result = NamedRoleSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "role"}: ${i.message}`).join("; ");
    throw new NamedRoleError(`Invalid named role: ${issues}`, 400);
  }
  return result.data;
}

export async function createNamedRole(input: unknown, actor: string): Promise<NamedRoleRecord> {
  const data = validate(input);
  if ((await declared()).some((r) => r.id === data.id)) {
    throw new NamedRoleError(`Named role "${data.id}" is declared in the seed file; edit it there`, 409);
  }
  const records = await readStored();
  if (records.some((r) => r.id === data.id))
    throw new NamedRoleError(`A named role with id "${data.id}" already exists`, 409);
  const record: NamedRoleRecord = { ...data, createdAt: new Date().toISOString(), createdBy: actor };
  await writeAll([...records, record]);
  return record;
}

export async function deleteNamedRole(id: string): Promise<NamedRoleRecord> {
  const records = await readStored();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new NamedRoleError(`Named role "${id}" not found`, 404);
  await writeAll(records.filter((r) => r.id !== id));
  return existing;
}
