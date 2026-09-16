import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { downloadFromGcs, parseGcsUri } from "@/lib/gcs";
import type { AccessSession } from "@/lib/access";
import { readBoundParams } from "@/lib/api/bound-params";
import type { CsvDelimiter } from "@/lib/export/csv";
import type { ResultExportFormat } from "@/lib/export/result-export";
import type { JobRecord } from "@/lib/storage/types";

/**
 * The export request and the file it becomes (docs/CONTEXT.md §4.22, §4.40): what the
 * route reads off the body before handing the export to the queue, and how the file a
 * worker wrote is found and served. Nothing here opens a datasource; the worker's side is
 * `./job.ts`.
 */
const FORMATS = new Set<string>(["csv", "json", "sql-insert", "sql-ddl"]);
const DELIMITERS = new Set<string>([",", ";", "\t"]);
export const EXPORT_TAB_NAME_MAX = 64;

export interface ExportJobPayload {
  session: AccessSession & { username: string };
  connectionId: string;
  sql: string;
  params?: unknown[];
  format: ResultExportFormat;
  csvDelimiter?: CsvDelimiter;
  tabName: string;
  reveal: boolean;
  ip?: string;
}

export interface ExportResult {
  file: string;
  extension: string;
  mimeType: string;
  rows: number;
  bytes: number;
}

export class ExportRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ExportRequestError";
  }
}

/** The body as the queue needs it: the form and the delimiter known, the params bindable, the tab name bounded. */
export function readExportRequest(
  body: Record<string, unknown>,
  session: AccessSession & { username: string },
  connectionId: string,
  ip?: string,
): ExportJobPayload {
  const format =
    typeof body.format === "string" && FORMATS.has(body.format) ? (body.format as ResultExportFormat) : null;
  const sql = typeof body.sql === "string" ? body.sql : "";
  if (sql.trim().length === 0 || format === null) {
    throw new ExportRequestError("sql and format (csv, json, sql-insert, sql-ddl) are required", 400);
  }
  const bound = readBoundParams(body.params);
  if (!bound.valid) throw new ExportRequestError(bound.message, 400);
  const csvDelimiter =
    typeof body.csvDelimiter === "string" && DELIMITERS.has(body.csvDelimiter)
      ? (body.csvDelimiter as CsvDelimiter)
      : undefined;
  return {
    session: {
      role: session.role,
      username: session.username,
      ...(session.groups ? { groups: session.groups } : {}),
      ...(session.namedRoles ? { namedRoles: session.namedRoles } : {}),
    },
    connectionId,
    sql,
    ...(bound.params ? { params: bound.params } : {}),
    format,
    ...(csvDelimiter ? { csvDelimiter } : {}),
    tabName:
      typeof body.tabName === "string" && body.tabName.trim()
        ? body.tabName.trim().slice(0, EXPORT_TAB_NAME_MAX)
        : "result",
    reveal: body.reveal === true,
    ...(ip ? { ip } : {}),
  };
}

/** Where exports land: EXPORT_DIR, or the data directory beside the backups. */
export function exportDir(): string {
  return process.env.EXPORT_DIR?.trim() || path.join(process.cwd(), "data", "exports");
}

/**
 * The bucket exports are kept in instead of EXPORT_DIR (docs/CONTEXT.md §4.46): what a
 * deployment of several studios and workers with no volume they all mount sets. Objects go
 * under `exports/`; the bucket's own lifecycle rule is their retention.
 */
export function exportBucket(): string | null {
  return process.env.EXPORT_GCS_BUCKET?.trim() || null;
}
export const EXPORT_OBJECT_PREFIX = "exports/";

/** The file of a finished export job, read back for the download; null while the job has no result. */
export async function exportFileOf(job: JobRecord): Promise<{ result: ExportResult; content: Buffer } | null> {
  const result = job.result as unknown as ExportResult | undefined;
  if (job.status !== "done" || !result?.file) return null;
  const inBucket = parseGcsUri(result.file);
  if (inBucket) {
    // Only an object a worker wrote under the export prefix of the configured bucket is ever served.
    if (inBucket.bucket !== exportBucket() || !inBucket.object.startsWith(EXPORT_OBJECT_PREFIX)) return null;
    try {
      const content = await downloadFromGcs(inBucket.bucket, inBucket.object);
      return content ? { result, content } : null;
    } catch {
      return null;
    }
  }
  // Only a file the worker wrote under the export directory is ever served.
  const file = path.resolve(result.file);
  if (!file.startsWith(path.resolve(exportDir()) + path.sep)) return null;
  try {
    await stat(file);
    return { result, content: await readFile(file) };
  } catch {
    return null;
  }
}
