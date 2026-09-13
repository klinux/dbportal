/**
 * Server-side data directory resolution. The data dir is wherever the SQLite
 * storage DB lives (writable in Docker as /app/data); the sample .libredb file
 * and generated auth credentials live alongside it. Launchers (npx/brew/deb)
 * point STORAGE_SQLITE_PATH at a platform-appropriate location.
 */
import * as path from "path";

export const DEFAULT_STORAGE_SQLITE_PATH = "./data/dbportal-storage.db";
/** Where the snapshot wrote by default; still used when it exists and the new file does not. */
export const LEGACY_STORAGE_SQLITE_PATH = "./data/libredb-storage.db";

/**
 * The SQLite path in force: the operator's, else the default - and, for one release, the
 * snapshot's default when that file exists and the new one does not, so an upgrade keeps
 * every stored connection and audit row without a rename step.
 */
export function resolveStorageSqlitePath(exists: (p: string) => boolean): string {
  const configured = process.env.STORAGE_SQLITE_PATH;
  if (configured) return configured;
  if (!exists(DEFAULT_STORAGE_SQLITE_PATH) && exists(LEGACY_STORAGE_SQLITE_PATH)) return LEGACY_STORAGE_SQLITE_PATH;
  return DEFAULT_STORAGE_SQLITE_PATH;
}

export function getDataDir(): string {
  return path.dirname(process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH);
}
