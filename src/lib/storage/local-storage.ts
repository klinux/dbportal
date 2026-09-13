/**
 * Pure localStorage CRUD operations.
 * All reads/writes go through these functions.
 * No event dispatching — that's the facade's responsibility.
 */

import { logger } from "@/lib/logger";

const KEY_PREFIX = "dbportal_";
/** The DOM event the facade fires on every write; the sync hook listens for it. */
export const STORAGE_CHANGE_EVENT = "dbportal-storage-change";
/** The prefix the snapshot inherited (docs/CONTEXT.md §5, layer 3): read once, moved, gone. */
const LEGACY_KEY_PREFIX = "libredb_";

/** Map collection names to localStorage keys */
const COLLECTION_KEYS: Record<string, string> = {
  connections: `${KEY_PREFIX}connections`,
  history: `${KEY_PREFIX}history`,
  saved_queries: `${KEY_PREFIX}saved_queries`,
  schema_snapshots: `${KEY_PREFIX}schema_snapshots`,
  saved_charts: `${KEY_PREFIX}saved_charts`,
  active_connection_id: `${KEY_PREFIX}active_connection_id`,
  audit_log: `${KEY_PREFIX}audit_log`,
  masking_config: `${KEY_PREFIX}masking_config`,
  threshold_config: `${KEY_PREFIX}threshold_config`,
};

function isClient(): boolean {
  return typeof window !== "undefined";
}

export function getKey(collection: string): string {
  return COLLECTION_KEYS[collection] || `${KEY_PREFIX}${collection}`;
}

/**
 * A value stored under the old prefix moves to the new key the first time it is read, so a
 * browser that used the snapshot keeps its connections, history and settings. One read per
 * key per session at most: once moved, the old key is gone.
 */
export function migrateLegacyKey(key: string): void {
  if (!key.startsWith(KEY_PREFIX)) return;
  const legacy = `${LEGACY_KEY_PREFIX}${key.slice(KEY_PREFIX.length)}`;
  try {
    if (localStorage.getItem(key) !== null) return;
    const old = localStorage.getItem(legacy);
    if (old === null) return;
    localStorage.setItem(key, old);
    localStorage.removeItem(legacy);
  } catch {
    // A storage that refuses is a storage that also refuses the read that follows.
  }
}

/**
 * Read raw JSON from localStorage.
 * Returns null if not found or parse fails.
 */
export function readJSON<T>(collection: string): T | null {
  if (!isClient()) return null;
  try {
    const key = getKey(collection);
    migrateLegacyKey(key);
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    logger.warn("Failed to parse JSON from localStorage", { key: getKey(collection) });
    return null;
  }
}

/**
 * Read raw string from localStorage.
 */
export function readString(collection: string): string | null {
  if (!isClient()) return null;
  const key = getKey(collection);
  migrateLegacyKey(key);
  return localStorage.getItem(key);
}

/**
 * Write JSON to localStorage.
 * Returns true on success, false on failure (e.g. QuotaExceededError).
 */
export function writeJSON(collection: string, data: unknown): boolean {
  if (!isClient()) return false;
  try {
    localStorage.setItem(getKey(collection), JSON.stringify(data));
    return true;
  } catch (error) {
    logger.warn("Failed to write to localStorage", {
      key: getKey(collection),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Write raw string to localStorage.
 * Returns true on success, false on failure (e.g. QuotaExceededError).
 */
export function writeString(collection: string, value: string): boolean {
  if (!isClient()) return false;
  try {
    localStorage.setItem(getKey(collection), value);
    return true;
  } catch (error) {
    logger.warn("Failed to write to localStorage", {
      key: getKey(collection),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Remove a key from localStorage.
 */
export function remove(collection: string): void {
  if (!isClient()) return;
  localStorage.removeItem(getKey(collection));
}
