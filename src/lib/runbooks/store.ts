import { SHARED_RUNBOOKS_OWNER } from "@/lib/datasources/owner";
import { loadConfig } from "@/lib/seed/config-loader";
import { RUNBOOK_PLACEHOLDER, RunbookSchema, type Runbook, type RunbookParam } from "@/lib/seed/types";
import { positionalPlaceholder } from "@/lib/sql/values";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { DatabaseType } from "@/lib/types";

/**
 * Runbooks (docs/CONTEXT.md §4.20): one statement declared once for one datasource, with
 * the values it asks for named as `{{name}}` - the incident lookup, the routine fix, the
 * report - that anyone who may open the datasource runs from the studio by filling a
 * form. The values never become statement text: `bindRunbook` turns each placeholder
 * into the engine's positional placeholder and hands the values to the driver's bind
 * path, the same path a generated statement takes (#290). What a runbook may do is
 * exactly what its runner may do by hand - the write gate, the guardrails, the limits
 * and the audit line all apply; the line also names the runbook.
 *
 * Declared in the seed file (`runbooks:`, read-only here) or by an administrator on the
 * Operations page, kept in the server store under a reserved owner.
 */

export type { Runbook, RunbookParam };

export interface RunbookRecord extends Runbook {
  createdAt: string;
  createdBy: string;
}

export type RunbookSource = "config" | "store";

export class RunbookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "RunbookError";
  }
}

const COLLECTION = "runbooks" as const;
const CACHE_TTL_MS = 5_000;
const STORE_UNAVAILABLE = "Runbooks need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: RunbookRecord[] } | null = null;

/** Tests only. */
export function resetRunbooksCache(): void {
  cache = null;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new RunbookError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readStored(): Promise<RunbookRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_RUNBOOKS_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: RunbookRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_RUNBOOKS_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

async function declared(): Promise<Runbook[]> {
  const config = await loadConfig();
  return config?.runbooks ?? [];
}

/** Every runbook with where it came from; the seed file's first. */
export async function listRunbooks(): Promise<{ runbook: Runbook | RunbookRecord; source: RunbookSource }[]> {
  const fromConfig = await declared();
  const ids = new Set(fromConfig.map((r) => r.id));
  const stored = (await readStored()).filter((r) => !ids.has(r.id));
  return [
    ...fromConfig.map((runbook) => ({ runbook, source: "config" as const })),
    ...stored.map((runbook) => ({ runbook, source: "store" as const })),
  ];
}

export async function findRunbook(id: string): Promise<Runbook | null> {
  return (await listRunbooks()).find((e) => e.runbook.id === id)?.runbook ?? null;
}

function validate(input: unknown): Runbook {
  const result = RunbookSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "runbook"}: ${i.message}`).join("; ");
    throw new RunbookError(`Invalid runbook: ${issues}`, 400);
  }
  return result.data;
}

export async function createRunbook(input: unknown, actor: string): Promise<RunbookRecord> {
  const data = validate(input);
  if ((await declared()).some((r) => r.id === data.id)) {
    throw new RunbookError(`Runbook "${data.id}" is declared in the seed file; edit it there`, 409);
  }
  const records = await readStored();
  if (records.some((r) => r.id === data.id))
    throw new RunbookError(`A runbook with id "${data.id}" already exists`, 409);
  const record: RunbookRecord = { ...data, createdAt: new Date().toISOString(), createdBy: actor };
  await writeAll([...records, record]);
  return record;
}

export async function deleteRunbook(id: string): Promise<RunbookRecord> {
  const records = await readStored();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new RunbookError(`Runbook "${id}" not found`, 404);
  await writeAll(records.filter((r) => r.id !== id));
  return existing;
}

/** One value as its declared type, or the reason it is not. */
function coerce(param: RunbookParam, raw: unknown): unknown {
  const label = param.label ?? param.name;
  // Blank text from the form is no value.
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (param.default !== undefined) return coerce(param, param.default);
    if (param.required === false) return null;
    throw new RunbookError(`"${label}" is required`, 400);
  }
  switch (param.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(n)) throw new RunbookError(`"${label}" must be a number`, 400);
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new RunbookError(`"${label}" must be true or false`, 400);
    default:
      if (typeof raw === "string") return raw;
      if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
      throw new RunbookError(`"${label}" must be text`, 400);
  }
}

/**
 * The statement to run and the values to bind, in the engine's own placeholder form.
 * Each occurrence of a placeholder is one position, so a value named twice is bound
 * twice - which every dialect here accepts - and no value ever becomes SQL text.
 */
export function bindRunbook(
  runbook: Runbook,
  values: Record<string, unknown>,
  dialect: DatabaseType,
): { sql: string; params: unknown[] } {
  const bound = new Map<string, unknown>();
  for (const param of runbook.params ?? []) bound.set(param.name, coerce(param, values[param.name]));
  const params: unknown[] = [];
  const sql = runbook.sql.replace(RUNBOOK_PLACEHOLDER, (_m, name: string) => {
    if (!bound.has(name)) throw new RunbookError(`Runbook names an undeclared parameter "${name}"`, 400);
    const placeholder = positionalPlaceholder(dialect, params.length + 1);
    if (placeholder === null) {
      throw new RunbookError(`Runbooks with parameters need an engine that binds them; ${dialect} does not`, 400);
    }
    params.push(bound.get(name));
    return placeholder;
  });
  return { sql, params };
}
