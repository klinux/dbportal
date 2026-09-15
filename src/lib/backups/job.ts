import type { AccessSession } from "@/lib/access";
import { enqueueJob, listJobs } from "@/lib/jobs/queue";
import { withNamedRoles } from "@/lib/roles/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import type { ManagedConnection } from "@/lib/seed";
import type { JobRecord } from "@/lib/storage/types";
import { BackupError } from "./errors";
import {
  type BackupFile,
  createBackup,
  isBackupName,
  listBackups,
  requireSupported,
  restoreAllowed,
  restoreBackup,
  toolAvailable,
} from "./store";

/**
 * A backup or a restore as a job (docs/CONTEXT.md §4.40): the route checks what it can
 * check without the tool - the engine, the tool on this image, restore never on production,
 * the file's name and that it is there - and hands the rest to the queue, one attempt, one
 * at a time per datasource. A worker resolves the datasource as the administrator would
 * and runs the tool; the file lands under BACKUP_DIR, which is shared storage when the
 * workers run apart from the studio. The route waits BACKUP_WAIT_MS for the outcome and
 * otherwise answers 202 with the job to poll.
 */
export type BackupAction = "create" | "restore";

export interface BackupJobPayload {
  action: BackupAction;
  datasourceId: string;
  datasourceName: string;
  /** The file to restore; a create names its own. */
  name?: string;
  session: AccessSession & { username: string };
}

export interface BackupOutcome {
  jobId: string;
  action: BackupAction;
  status: JobRecord["status"];
  /** The file, once the job is done. */
  backup?: BackupFile & { object?: string };
  error?: string;
}

export const BACKUP_WAIT_MS = 20_000;

/** The queue's word on a job of ours, as the routes and the panel read it. */
export function backupOutcome(job: JobRecord): BackupOutcome {
  const payload = job.payload as unknown as BackupJobPayload;
  const outcome: BackupOutcome = { jobId: job.id, action: payload.action, status: job.status };
  if (job.status === "done" && job.result) outcome.backup = job.result as unknown as BackupFile;
  if (job.status === "lost") outcome.error = `The worker running this ${what(payload.action)} stopped answering`;
  if (job.status === "failed")
    outcome.error = `The ${what(payload.action)} failed (${job.error ?? "error"}); the server log has the tool's output`;
  return outcome;
}

function what(action: BackupAction): string {
  return action === "create" ? "backup" : "restore";
}

export function isBackupJob(job: JobRecord | null): job is JobRecord {
  return job !== null && job.kind === "backup";
}

/** The backup job open on a datasource, if one is; what the panel resumes polling after a reload. */
export async function openBackupJob(datasourceId: string): Promise<BackupOutcome | null> {
  for (const status of ["running", "queued"] as const) {
    const open = await listJobs({ kind: "backup", status, limit: 100 });
    const ours = open.find((j) => (j.payload as { datasourceId?: string }).datasourceId === datasourceId);
    if (ours) return backupOutcome(ours);
  }
  return null;
}

/** Check what a request can be checked for here, then hand it to the queue. */
export async function enqueueBackup(
  connection: ManagedConnection,
  action: BackupAction,
  session: AccessSession & { username: string },
  name?: string,
): Promise<JobRecord> {
  requireSupported(connection);
  const id = connection.seedId ?? connection.id;
  if (action === "restore") {
    if (!restoreAllowed(connection)) {
      throw new BackupError(
        "Restore is not offered on a production datasource; its backups are exported to the bucket",
        403,
      );
    }
    if (!name || !isBackupName(name)) throw new BackupError("The backup name is malformed", 400);
    if (!(await listBackups(id)).some((f) => f.name === name)) {
      throw new BackupError(`Backup "${name}" not found for this datasource`, 404);
    }
  }
  if (!(await toolAvailable())) {
    throw new BackupError(`${action === "create" ? "pg_dump" : "pg_restore"} is not installed on this server`, 503);
  }
  const open = await openBackupJob(id);
  if (open) throw new BackupError(`A ${what(open.action)} is already ${open.status} on "${connection.name}"`, 409);
  const payload: BackupJobPayload = {
    action,
    datasourceId: id,
    datasourceName: connection.name,
    ...(name ? { name } : {}),
    session: { role: session.role, username: session.username, groups: session.groups, namedRoles: session.namedRoles },
  };
  return enqueueJob({
    kind: "backup",
    payload: payload as unknown as Record<string, unknown>,
    requestedBy: session.username,
    maxAttempts: 1,
  });
}

/** The worker's side: the datasource resolved as the administrator would, then the tool. */
export async function runBackupJob(job: JobRecord): Promise<BackupFile & { object?: string }> {
  const payload = job.payload as unknown as BackupJobPayload;
  const session = await withNamedRoles(payload.session);
  const connection = await resolveConnection({ connectionId: `seed:${payload.datasourceId}` }, session);
  if (payload.action === "restore") return restoreBackup(connection, payload.name ?? "", session.username);
  return createBackup(connection, session.username);
}
