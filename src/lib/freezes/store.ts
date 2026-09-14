import { randomUUID } from "node:crypto";
import { SHARED_FREEZES_OWNER } from "@/lib/datasources/owner";
import { loadConfig } from "@/lib/seed/config-loader";
import { FreezeWindowSchema, type FreezeWindow } from "@/lib/seed/types";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Freeze windows (docs/CONTEXT.md §4.17): between two instants, no statement that writes
 * runs on the datasources the window names - or on any datasource when it names none -
 * whoever asks, approval or not. A deploy, a peak day, an incident. Declared once in the
 * seed file (`freezeWindows:`, read-only here) or by an administrator on the Security
 * page, kept in the server store under a reserved owner; ended early by deleting it.
 *
 * The check is a comparison of instants and ids on every write, from the cached list -
 * there is no scheduler, nothing to keep alive, and a window that has passed is simply
 * one that no longer covers now.
 */

export type { FreezeWindow };

export interface FreezeWindowRecord extends FreezeWindow {
  createdAt: string;
  createdBy: string;
}

export type FreezeSource = "config" | "store";

export class FreezeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "FreezeError";
  }
}

const COLLECTION = "freeze_windows" as const;
const CACHE_TTL_MS = 5_000;
const STORE_UNAVAILABLE = "Freeze windows need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: FreezeWindowRecord[] } | null = null;

/** Tests only. */
export function resetFreezeCache(): void {
  cache = null;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new FreezeError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readStored(): Promise<FreezeWindowRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_FREEZES_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: FreezeWindowRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_FREEZES_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

async function declared(): Promise<FreezeWindow[]> {
  const config = await loadConfig();
  return config?.freezeWindows ?? [];
}

/** Every window with where it came from; the seed file's first. */
export async function listFreezeWindows(): Promise<
  { window: FreezeWindow | FreezeWindowRecord; source: FreezeSource }[]
> {
  const fromConfig = await declared();
  const ids = new Set(fromConfig.map((w) => w.id));
  const stored = (await readStored()).filter((w) => !ids.has(w.id));
  return [
    ...fromConfig.map((window) => ({ window, source: "config" as const })),
    ...stored.map((window) => ({ window, source: "store" as const })),
  ];
}

/** Whether `window` covers `datasourceId` at `now`. */
export function covers(window: FreezeWindow, datasourceId: string, now = Date.now()): boolean {
  if (now < Date.parse(window.from) || now >= Date.parse(window.until)) return false;
  return !window.datasources || window.datasources.length === 0 || window.datasources.includes(datasourceId);
}

/** The window that freezes writes on `datasourceId` right now, if any - the one ending last when several do. */
export async function activeFreeze(datasourceId: string, now = Date.now()): Promise<FreezeWindow | null> {
  const active = (await listFreezeWindows()).map((e) => e.window).filter((w) => covers(w, datasourceId, now));
  if (active.length === 0) return null;
  return active.sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
}

function validate(input: unknown): FreezeWindow {
  const result = FreezeWindowSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "window"}: ${i.message}`).join("; ");
    throw new FreezeError(`Invalid freeze window: ${issues}`, 400);
  }
  return result.data;
}

export async function createFreezeWindow(input: unknown, actor: string): Promise<FreezeWindowRecord> {
  const data = validate(input);
  if ((await declared()).some((w) => w.id === data.id)) {
    throw new FreezeError(`Freeze window "${data.id}" is declared in the seed file; edit it there`, 409);
  }
  const records = await readStored();
  if (records.some((r) => r.id === data.id))
    throw new FreezeError(`A freeze window with id "${data.id}" already exists`, 409);
  const record: FreezeWindowRecord = { ...data, createdAt: new Date().toISOString(), createdBy: actor };
  await writeAll([...records, record]);
  return record;
}

/** Delete: how a window is ended early. */
export async function deleteFreezeWindow(id: string): Promise<FreezeWindowRecord> {
  const records = await readStored();
  const existing = records.find((r) => r.id === id);
  if (!existing) throw new FreezeError(`Freeze window "${id}" not found`, 404);
  await writeAll(records.filter((r) => r.id !== id));
  return existing;
}
