import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { emitAuditEvent } from "@/lib/audit";
import { withOneShotTunnel } from "@/lib/db/factory";
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed";
import type { SSLMode } from "@/lib/types";
import { BackupError } from "./errors";
import { uploadToGcs } from "./gcs";

/**
 * Backups (docs/CONTEXT.md §4.14). A dump of one datasource, taken by the engine's own tool
 * (`pg_dump -Fc` today; PostgreSQL only) into BACKUP_DIR, and - when BACKUP_GCS_BUCKET is
 * set - copied to the bucket, which is the production shape: an export that leaves the pod.
 * Restore (`pg_restore --clean`) is a development affordance and is refused on a
 * production datasource outright, whatever the caller's role: a production database is
 * restored by the people who run it, with a runbook, not from a button.
 *
 * The credential reaches the tool through its environment (PGPASSWORD), never an
 * argument, so it is not in the process list; a tool's stderr goes to the server log and
 * never to the caller. File names are generated here and validated on the way back, so a
 * name from a request cannot leave the datasource's own directory.
 */
const run = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_MAX = 4 * 1024;
const FILE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.dump$/;
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_KEY = Symbol.for("dbportal.backup-tool");

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export function backupsDir(): string {
  return process.env.BACKUP_DIR?.trim() || path.join(process.cwd(), "data", "backups");
}

export function gcsBucket(): string | null {
  return process.env.BACKUP_GCS_BUCKET?.trim() || null;
}

export function backupSupported(type: string): boolean {
  return type === "postgres";
}

export function restoreAllowed(connection: Pick<ManagedConnection, "environment">): boolean {
  return connection.environment !== "production";
}

function timeoutMs(): number {
  const n = Number(process.env.BACKUP_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Whether pg_dump answers on this server; asked once per process. */
export async function toolAvailable(): Promise<boolean> {
  const holder = globalThis as unknown as { [TOOL_KEY]?: Promise<boolean> };
  if (!holder[TOOL_KEY]) {
    holder[TOOL_KEY] = run("pg_dump", ["--version"]).then(
      () => true,
      () => false,
    );
  }
  return holder[TOOL_KEY];
}

/** Tests only. */
export function resetToolCheck(): void {
  delete (globalThis as unknown as { [TOOL_KEY]?: Promise<boolean> })[TOOL_KEY];
}

const SSL_MODE: Record<SSLMode, string> = {
  disable: "disable",
  require: "require",
  "verify-system": "verify-full",
  "verify-ca": "verify-ca",
  "verify-full": "verify-full",
};

function toolEnv(connection: ManagedConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(connection.password ? { PGPASSWORD: connection.password } : {}),
    ...(connection.ssl?.mode ? { PGSSLMODE: SSL_MODE[connection.ssl.mode] } : {}),
  };
}

function addressArgs(connection: ManagedConnection): string[] {
  return [
    ...(connection.host ? ["-h", connection.host] : []),
    ...(connection.port ? ["-p", String(connection.port)] : []),
    ...(connection.user ? ["-U", connection.user] : []),
    ...(connection.database ? ["-d", connection.database] : []),
    "--no-password",
  ];
}

async function runTool(tool: string, args: string[], env: NodeJS.ProcessEnv, what: string): Promise<void> {
  try {
    await run(tool, args, { env, timeout: timeoutMs(), maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").slice(-STDERR_MAX);
    const killed = (error as { killed?: boolean }).killed === true;
    logger.error(`${tool} failed`, error, { route: "backups", what, stderr, killed });
    throw new BackupError(killed ? `${what} timed out` : `${what} failed; the server log has the tool's output`, 502);
  }
}

function datasourceDir(datasourceId: string): string {
  if (!ID_SHAPE.test(datasourceId)) throw new BackupError("datasourceId is malformed", 400);
  return path.join(backupsDir(), datasourceId);
}

export async function listBackups(datasourceId: string): Promise<BackupFile[]> {
  const dir = datasourceDir(datasourceId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((name) => FILE_SHAPE.test(name))
      .map(async (name) => {
        const info = await stat(path.join(dir, name));
        return { name, size: info.size, createdAt: info.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

function requireSupported(connection: ManagedConnection): void {
  if (!backupSupported(connection.type))
    throw new BackupError(
      `Backups are offered for PostgreSQL datasources only; "${connection.name}" is ${connection.type}`,
      400,
    );
}

/** Take a dump; upload it when a bucket is configured; return the file. */
export async function createBackup(
  connection: ManagedConnection,
  actor: string,
): Promise<BackupFile & { object?: string }> {
  requireSupported(connection);
  if (!(await toolAvailable())) throw new BackupError("pg_dump is not installed on this server", 503);
  const id = connection.seedId ?? connection.id;
  const dir = datasourceDir(id);
  await mkdir(dir, { recursive: true });
  const name = `${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z")}.dump`;
  const file = path.join(dir, name);
  try {
    await withOneShotTunnel(connection, (effective) =>
      runTool(
        "pg_dump",
        ["-Fc", ...addressArgs(effective as ManagedConnection), "-f", file],
        toolEnv(effective as ManagedConnection),
        "Backup",
      ),
    );
  } catch (error) {
    audit("created", id, connection.name, actor, "failure");
    throw error;
  }
  audit("created", id, connection.name, actor, "success");
  const info = await stat(file);
  const record: BackupFile & { object?: string } = { name, size: info.size, createdAt: info.mtime.toISOString() };
  const bucket = gcsBucket();
  if (bucket) {
    try {
      record.object = await uploadToGcs(bucket, `dbportal/${id}/${name}`, file);
      audit("uploaded", id, connection.name, actor, "success");
    } catch (error) {
      audit("uploaded", id, connection.name, actor, "failure");
      throw error;
    }
  }
  return record;
}

/** Restore one of the datasource's own files over it; never on production. */
export async function restoreBackup(connection: ManagedConnection, name: string, actor: string): Promise<BackupFile> {
  requireSupported(connection);
  if (!restoreAllowed(connection)) {
    throw new BackupError(
      "Restore is not offered on a production datasource; its backups are exported to the bucket",
      403,
    );
  }
  if (!FILE_SHAPE.test(name)) throw new BackupError("The backup name is malformed", 400);
  const id = connection.seedId ?? connection.id;
  const file = path.join(datasourceDir(id), name);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    throw new BackupError(`Backup "${name}" not found for this datasource`, 404);
  }
  if (!(await toolAvailable())) throw new BackupError("pg_restore is not installed on this server", 503);
  try {
    await withOneShotTunnel(connection, (effective) =>
      runTool(
        "pg_restore",
        ["--clean", "--if-exists", "--no-owner", ...addressArgs(effective as ManagedConnection), file],
        toolEnv(effective as ManagedConnection),
        "Restore",
      ),
    );
  } catch (error) {
    audit("restored", id, connection.name, actor, "failure");
    throw error;
  }
  audit("restored", id, connection.name, actor, "success");
  return { name, size: info.size, createdAt: info.mtime.toISOString() };
}

function audit(
  action: "created" | "uploaded" | "restored",
  datasourceId: string,
  connectionName: string,
  actor: string,
  result: "success" | "failure",
): void {
  try {
    emitAuditEvent({
      type: "backup",
      action,
      target: datasourceId,
      connectionName,
      user: actor,
      result,
      ...(result === "failure" ? { reason: "execution_failed" as const } : {}),
    });
  } catch (error) {
    logger.error("Failed to record backup audit event", error, { route: "backups" });
  }
}
