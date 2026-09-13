import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import { isVaultReference } from "@/lib/vault/credentials";
import { SeedConnectionSchema, type SeedConnection } from "@/lib/seed/types";
import type { DatabaseConnection } from "@/lib/types";
import { SHARED_DATASOURCES_OWNER } from "./owner";

/**
 * Shared datasources: the ones an administrator creates at runtime, for everyone the roles
 * name (docs/CONTEXT.md §4.1 step B).
 *
 * The seed YAML stays the GitOps way to declare a datasource; this store is the runtime way.
 * Both feed `getManagedConnections()` (src/lib/seed/index.ts), so the browser sees one list
 * and `resolveConnection` opens either kind by the same `seed:<id>` handle. A record here IS a
 * `SeedConnection` - the same zod schema validates it, the same credential resolver honours a
 * `${ENV_VAR}` reference in it - plus who wrote it and when.
 *
 * Persisted in `user_storage` under `SHARED_DATASOURCES_OWNER`, in the `connections`
 * collection, which is the one collection the storage layer seals credentials in. That is
 * the whole reason for the reuse: a second collection would have to re-implement encryption,
 * and a second table would have to re-implement it in both providers.
 *
 * Read on every `resolveConnection`, so reads are cached for a few seconds and every write
 * refreshes the cache in this process. The TTL bounds staleness across replicas.
 */

export class SharedDatasourceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SharedDatasourceError";
  }
}

export interface SharedDatasourceRecord extends SeedConnection {
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** A record as the admin API returns it: every secret field replaced by a statement about it. */
export interface SharedDatasourceView extends Omit<SharedDatasourceRecord, "password" | "connectionString" | "ssl"> {
  ssl?: Omit<NonNullable<SharedDatasourceRecord["ssl"]>, "clientKey">;
  hasPassword: boolean;
  /** The `${ENV_VAR}` name the password references, when it is a reference rather than a value. */
  passwordEnv?: string;
  /** The `vault:` reference the password is, when it is one (docs/CONTEXT.md §4.5). */
  passwordVault?: string;
  hasConnectionString: boolean;
}

const COLLECTION = "connections" as const;
const CACHE_TTL_MS = 5_000;
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const STORE_UNAVAILABLE = "Shared datasources need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: SharedDatasourceRecord[] } | null = null;

/** Tests only: forget what this process has read. */
export function resetSharedDatasourceCache(): void {
  cache = null;
}

export function isSharedStoreAvailable(): boolean {
  return isServerStorageEnabled();
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new SharedDatasourceError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readAll(): Promise<SharedDatasourceRecord[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = await provider.getCollection(SHARED_DATASOURCES_OWNER, COLLECTION);
  // The storage layer types the collection as the browser's connection list; a record here is
  // that shape plus roles and authorship, which the encrypting provider passes through untouched.
  const records = (rows ?? []) as unknown as SharedDatasourceRecord[];
  cache = { at: Date.now(), records };
  return records;
}

async function writeAll(records: SharedDatasourceRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_DATASOURCES_OWNER, COLLECTION, records as unknown as DatabaseConnection[]);
  cache = { at: Date.now(), records };
}

/**
 * Every shared datasource, secrets included - for the server's own use (`getManagedConnections`).
 * Empty, not an error, when there is no server store: a deployment on STORAGE_PROVIDER=local has
 * the seed YAML and nothing else, which is a valid way to run.
 */
export async function listSharedDatasources(): Promise<SharedDatasourceRecord[]> {
  if (!isSharedStoreAvailable()) return [];
  return readAll();
}

function validate(input: unknown): SeedConnection {
  const result = SeedConnectionSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "datasource"}: ${i.message}`).join("; ");
    throw new SharedDatasourceError(`Invalid datasource: ${issues}`, 400);
  }
  // A shared datasource is never an editable copy: `managed:false` is what makes the browser
  // send a connection object back, which the server refuses for everyone but an admin.
  return { ...result.data, managed: true };
}

export async function createSharedDatasource(input: unknown, actor: string): Promise<SharedDatasourceRecord> {
  const data = validate(input);
  const records = await readAll();
  if (records.some((r) => r.id === data.id)) {
    throw new SharedDatasourceError(`A datasource with id "${data.id}" already exists`, 409);
  }
  const now = new Date().toISOString();
  const record: SharedDatasourceRecord = {
    ...data,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  };
  await writeAll([...records, record]);
  return record;
}

/**
 * Replace a datasource. A secret the caller leaves out (or blank) is KEPT: the admin API never
 * returns secrets, so an edit that round-trips the view would otherwise wipe every password on
 * save. Sending a value replaces it; there is no way to blank one except to send a reference or
 * delete the datasource.
 */
export async function updateSharedDatasource(
  id: string,
  input: unknown,
  actor: string,
): Promise<SharedDatasourceRecord> {
  const candidate = typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>), id } : input;
  const data = validate(candidate);
  const records = await readAll();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new SharedDatasourceError(`Datasource "${id}" not found`, 404);

  const record: SharedDatasourceRecord = {
    ...data,
    password: data.password || existing.password,
    connectionString: data.connectionString || existing.connectionString,
    ssl:
      data.ssl && !data.ssl.clientKey && existing.ssl?.clientKey
        ? { ...data.ssl, clientKey: existing.ssl.clientKey }
        : data.ssl,
    createdAt: existing.createdAt,
    createdBy: existing.createdBy,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  await writeAll(records.map((r) => (r.id === id ? record : r)));
  return record;
}

export async function deleteSharedDatasource(id: string): Promise<SharedDatasourceRecord> {
  const records = await readAll();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new SharedDatasourceError(`Datasource "${id}" not found`, 404);
  await writeAll(records.filter((r) => r.id !== id));
  return existing;
}

/** What leaves the server: the record with every secret replaced by a fact about it. */
export function toSharedDatasourceView(record: SharedDatasourceRecord): SharedDatasourceView {
  const { password, connectionString, ssl, ...rest } = record;
  const envMatch = password?.match(ENV_REFERENCE);
  const publicSsl = ssl ? Object.fromEntries(Object.entries(ssl).filter(([key]) => key !== "clientKey")) : undefined;
  return {
    ...rest,
    ...(publicSsl ? { ssl: publicSsl } : {}),
    hasPassword: !!password,
    ...(envMatch ? { passwordEnv: envMatch[1] } : {}),
    ...(isVaultReference(password) ? { passwordVault: password } : {}),
    hasConnectionString: !!connectionString,
  };
}
