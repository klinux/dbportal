import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { canExport, isReadStatement } from "@/lib/access";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { emitAuditEvent } from "@/lib/audit";
import { auditExecution } from "@/lib/audit-execution";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { buildResultExport } from "@/lib/export/result-export";
import { capPrepareOptions, withConcurrency } from "@/lib/limits";
import { logger } from "@/lib/logger";
import { maskResult } from "@/lib/masking/store";
import { withNamedRoles } from "@/lib/roles/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { uploadToGcs } from "@/lib/gcs";
import {
  EXPORT_OBJECT_PREFIX,
  exportBucket,
  exportDir,
  ExportRequestError,
  type ExportJobPayload,
  type ExportResult,
} from "./request";

/**
 * An export as a job (docs/CONTEXT.md §4.22, §4.40): the worker runs the statement again
 * on a read-only pool, bounded, the rows leave masked exactly as the grid gets them, the
 * file is written by the same writers as before into EXPORT_DIR under the job's id - or,
 * with EXPORT_GCS_BUCKET set, into the bucket, which is what lets a studio that is not the
 * worker serve it (§4.46) - and two lines go on the trail - the execution and the
 * `data_export`. The rule is checked again here, as the route checked it, because the
 * worker is what opens the datasource. Files older than EXPORT_RETENTION_HOURS are removed
 * from the directory after each export; the bucket's lifecycle rule does the same there.
 */
export const EXPORT_MAX_ROWS = 100_000;
export const DEFAULT_EXPORT_RETENTION_HOURS = 24;
const BOM = "﻿";
export const ROUTE = "POST /api/db/export";

export function exportRetentionMs(): number {
  const hours = Number(process.env.EXPORT_RETENTION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_EXPORT_RETENTION_HOURS) * 3_600_000;
}

/** Remove the files past retention; a directory that cannot be read is one warning. */
export async function pruneExports(now = Date.now()): Promise<number> {
  const dir = exportDir();
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs < exportRetentionMs()) continue;
      await unlink(file).catch(() => {});
      removed++;
    }
  } catch (error) {
    logger.warn("Export directory could not be pruned", { route: "export/job", error: (error as Error).name });
  }
  return removed;
}

/** The worker's side: what the route used to do inside the request. */
export async function runExport(payload: ExportJobPayload, jobId: string): Promise<ExportResult> {
  const session = await withNamedRoles(payload.session);
  const connection = await resolveConnection({ connectionId: payload.connectionId }, session);
  if (!canExport(connection, session)) {
    auditRoleDenial({ route: ROUTE, user: session.username, reason: "export_not_allowed" });
    throw new ExportRequestError(`Exports are not allowed for you on "${connection.name}"`, 403);
  }
  if (!isReadStatement(payload.sql, connection.type)) {
    throw new ExportRequestError("Only a statement that reads can be exported", 400);
  }
  const provider = await getOrCreateProvider(connection, {
    applicationName: applicationNameFor(session.username),
    readOnly: true,
  });
  const prepared = provider.prepareQuery(payload.sql, capPrepareOptions({ limit: EXPORT_MAX_ROWS }, connection.limits));
  const result = await withConcurrency(connection, session.username, () =>
    auditExecution(
      {
        route: ROUTE,
        action: "export",
        user: session.username,
        connectionName: connection.name,
        statement: prepared.query,
        ...(payload.ip ? { ip: payload.ip } : {}),
      },
      () => provider.query(prepared.query, payload.params),
    ),
  );
  const served = await maskResult(result, { session, connectionName: connection.name, reveal: payload.reveal });
  const file = buildResultExport(payload.format, {
    rows: served.rows,
    fields: served.fields,
    tabName: payload.tabName,
    dialect: connection.type,
    columnTypes: result.columnTypes,
    csvDelimiter: payload.csvDelimiter,
  });
  const content = file.mimeType.startsWith("text/csv") ? `${BOM}${file.content}` : file.content;
  const bucket = exportBucket();
  let target: string;
  if (bucket) {
    const object = `${EXPORT_OBJECT_PREFIX}${jobId}.${file.extension}`;
    await uploadToGcs(bucket, object, { content });
    target = `gs://${bucket}/${object}`;
  } else {
    const dir = exportDir();
    await mkdir(dir, { recursive: true });
    target = path.join(dir, `${jobId}.${file.extension}`);
    await writeFile(target, content, "utf8");
  }
  emitAuditEvent({
    type: "data_export",
    action: payload.format,
    target: ROUTE,
    user: session.username,
    result: "success",
    connectionName: connection.name,
    details: `${served.rows.length} rows${prepared.wasLimited && served.rows.length === prepared.limit ? " (cut at the cap)" : ""}`,
    rows: served.rows.length,
    ...(payload.ip ? { ip: payload.ip } : {}),
  });
  if (!bucket) await pruneExports();
  return {
    file: target,
    extension: file.extension,
    mimeType: file.mimeType,
    rows: served.rows.length,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}
