import { SHARED_ENVIRONMENTS_OWNER } from "@/lib/datasources/owner";
import { loadConfig } from "@/lib/seed/config-loader";
import { EnvironmentSchema, type Environment } from "@/lib/seed/types";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import { BUILTIN_ENVIRONMENTS, PRODUCTION_ENVIRONMENT } from "@/lib/types";

/**
 * Environments (docs/CONTEXT.md §4.36, asked 2026-09-14): the labels a datasource is filed
 * under - production, staging, development, local, other - were fixed in code. They are
 * now a list: the five built-ins, the seed file's `environments:`, and what an
 * administrator declares on the Security page, merged by id (a later source relabels or
 * recolours an earlier one, never removes it) and ordered. `production` stays the one with
 * meaning - exports closed by default, no seed, no restore - and cannot be deleted; a
 * custom environment is a name and a colour. A datasource's environment must be on the
 * list when it is declared here; the seed file's are taken as they are.
 */
export type { Environment };

export interface EnvironmentRecord extends Environment {
  createdAt: string;
  createdBy: string;
}

export type EnvironmentSource = "builtin" | "config" | "store";

export class EnvironmentError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "EnvironmentError";
  }
}

const COLLECTION = "environments" as const;
const CACHE_TTL_MS = 5_000;
const STORE_UNAVAILABLE = "Environments need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: EnvironmentRecord[] } | null = null;

/** Tests only. */
export function resetEnvironmentsCache(): void {
  cache = null;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new EnvironmentError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readStored(): Promise<EnvironmentRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_ENVIRONMENTS_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: EnvironmentRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_ENVIRONMENTS_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

async function declared(): Promise<Environment[]> {
  const config = await loadConfig();
  return config?.environments ?? [];
}

/** Every environment with where its current definition came from, ordered. */
export async function listEnvironments(): Promise<{ environment: Environment; source: EnvironmentSource }[]> {
  const merged = new Map<string, { environment: Environment; source: EnvironmentSource }>();
  for (const environment of BUILTIN_ENVIRONMENTS) merged.set(environment.id, { environment, source: "builtin" });
  for (const environment of await declared()) merged.set(environment.id, { environment, source: "config" });
  for (const environment of await readStored()) {
    const { createdAt: _at, createdBy: _by, ...plain } = environment;
    merged.set(environment.id, { environment: plain, source: "store" });
  }
  return [...merged.values()].sort(
    (a, b) => a.environment.order - b.environment.order || a.environment.label.localeCompare(b.environment.label),
  );
}

export async function environmentIds(): Promise<Set<string>> {
  return new Set((await listEnvironments()).map((e) => e.environment.id));
}

function validate(input: unknown): Environment {
  const result = EnvironmentSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "environment"}: ${i.message}`).join("; ");
    throw new EnvironmentError(`Invalid environment: ${issues}`, 400);
  }
  return result.data;
}

/** Declare or redefine one: a built-in or a seed-file environment may be relabelled and recoloured here, never removed. */
export async function saveEnvironment(input: unknown, actor: string): Promise<EnvironmentRecord> {
  const data = validate(input);
  const records = await readStored();
  const record: EnvironmentRecord = { ...data, createdAt: new Date().toISOString(), createdBy: actor };
  await writeAll([...records.filter((r) => r.id !== data.id), record]);
  return record;
}

/** Delete: only a stored definition, never `production`, and never one a stored datasource still uses. */
export async function deleteEnvironment(
  id: string,
  inUse: (id: string) => Promise<boolean>,
): Promise<EnvironmentRecord> {
  if (id === PRODUCTION_ENVIRONMENT)
    throw new EnvironmentError(
      `"${PRODUCTION_ENVIRONMENT}" is the one environment with rules of its own and stays`,
      409,
    );
  const records = await readStored();
  const existing = records.find((r) => r.id === id);
  if (!existing)
    throw new EnvironmentError(
      `Environment "${id}" is not declared here (a built-in or seed-file one cannot be deleted)`,
      404,
    );
  if (await inUse(id)) throw new EnvironmentError(`Environment "${id}" is still used by a datasource`, 409);
  await writeAll(records.filter((r) => r.id !== id));
  return existing;
}
