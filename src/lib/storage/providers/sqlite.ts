/**
 * SQLite Server Storage Provider
 * Uses better-sqlite3 (Node.js compatible, works in production runner).
 * WAL mode enabled for concurrent read performance.
 */

import type {
  ApprovalQuery,
  ApprovalRequest,
  AuditEventFilter,
  AuditEventQuery,
  ServerStorageProvider,
  StorageCollection,
  StorageData,
  JobQuery,
  JobRecord,
  JobStatus,
} from "../types";
import type { AuditEvent } from "@/lib/audit";
import { STORAGE_COLLECTIONS } from "../types";
import type BetterSqlite3 from "better-sqlite3";
import { logger } from "@/lib/logger";
import { resolveStorageSqlitePath } from "@/lib/data-dir";
import { existsSync } from "fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any;

/**
 * better-sqlite3 has shipped N-API prebuilds since v13, so its binding is no
 * longer tied to the ABI of the Node that installed it and this guard should
 * not fire through a normal install. It stays for the cases that still can:
 * a pinned older better-sqlite3 (v12 and earlier compiled per Node ABI), or a
 * node_modules assembled from mixed installs. Either way the raw failure reads
 * like an installation bug - translate it into an actionable message.
 *
 * Only the NODE_MODULE_VERSION text (emitted by Node's module-register
 * check) is treated as an ABI mismatch. A bare ERR_DLOPEN_FAILED is NOT
 * enough: missing shared libraries, a libc mismatch, or a corrupted file
 * also surface as ERR_DLOPEN_FAILED - on any Node version - and must keep
 * their original error rather than a misleading ABI claim.
 */
function isNodeAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message);
}

const JOB_COLUMNS = "id, kind, status, run_at, lease_until, attempts, max_attempts, worker, data";
interface JobRow {
  id: string;
  kind: string;
  status: string;
  run_at: string;
  lease_until: string | null;
  attempts: number;
  max_attempts: number;
  worker: string | null;
  data: string;
}

/** The record as JSON, with the columns a worker changes laid over it. */
function jobFromRow(row: JobRow): JobRecord {
  const record = JSON.parse(row.data) as JobRecord;
  return {
    ...record,
    status: row.status as JobStatus,
    runAt: row.run_at,
    leaseUntil: row.lease_until ?? undefined,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    worker: row.worker ?? undefined,
  };
}

export class SQLiteStorageProvider implements ServerStorageProvider {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || resolveStorageSqlitePath(existsSync);
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import to avoid requiring better-sqlite3 when not needed
      if (!Database) {
        const mod = await import("better-sqlite3");
        Database = mod.default;
      }

      // Ensure directory exists
      const path = await import("path");
      const fs = await import("fs");
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath) as BetterSqlite3.Database;

      // Enable WAL mode for better concurrent read performance
      this.db!.pragma("journal_mode = WAL");

      // Create table
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS user_storage (
          user_id    TEXT NOT NULL,
          collection TEXT NOT NULL,
          data       TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, collection)
        )
      `);
      // The audit record (docs/CONTEXT.md §4.2); see the PostgreSQL provider for the shape.
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id   TEXT PRIMARY KEY,
          ts   TEXT NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_events_ts ON audit_events (ts DESC);
        CREATE INDEX IF NOT EXISTS audit_events_type_ts ON audit_events (type, ts DESC);
      `);
      // Write approvals (docs/CONTEXT.md §4.6): the record as JSON plus the columns the
      // gate and the reviewer list filter on.
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id            TEXT PRIMARY KEY,
          ts            TEXT NOT NULL,
          status        TEXT NOT NULL,
          requester     TEXT NOT NULL,
          datasource_id TEXT NOT NULL,
          data          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS approval_requests_lookup ON approval_requests (datasource_id, requester, status);
      `);
      // The job queue (docs/CONTEXT.md §4.40); see the PostgreSQL provider for the shape.
      // One writer at a time in SQLite, so a claim inside a transaction is atomic by nature.
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL,
          status       TEXT NOT NULL,
          run_at       TEXT NOT NULL,
          lease_until  TEXT,
          attempts     INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 1,
          worker       TEXT,
          data         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, run_at);
      `);
    } catch (error) {
      logger.error("SQLite storage initialization failed", error, { provider: "sqlite", path: this.dbPath });
      if (isNodeAbiMismatch(error)) {
        throw new Error(
          // Deliberately NOT phrased as a floor ("Node 24 or newer"): a native
          // binding loads only on the exact ABI it was built against, so a
          // NEWER Node fails here too and would read such a message as already
          // satisfied.
          `Server-side SQLite storage (STORAGE_PROVIDER=sqlite) cannot start on Node ${process.versions.node}: the better-sqlite3 native module in this install was built for a different Node ABI and cannot load here. ` +
            "better-sqlite3 13 ships N-API prebuilds that work across Node majors, so this normally means a pinned older better-sqlite3 or an incomplete node_modules - reinstall dependencies, or use STORAGE_PROVIDER=postgres or STORAGE_PROVIDER=local instead. " +
            `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensureDb();
    const stmt = this.db!.prepare("SELECT collection, data FROM user_storage WHERE user_id = ?");
    const rows = stmt.all(userId) as { collection: string; data: string }[];

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(row.data);
      } catch {
        logger.warn("Skipping corrupted storage data", { provider: "sqlite", collection: row.collection });
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    this.ensureDb();
    const stmt = this.db!.prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = ?");
    const row = stmt.get(userId, collection) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as StorageData[K];
    } catch {
      logger.warn("Corrupted data in storage collection", { provider: "sqlite", collection });
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT INTO user_storage (user_id, collection, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, collection)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    stmt.run(userId, collection, JSON.stringify(data));
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT INTO user_storage (user_id, collection, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, collection)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);

    const tx = this.db!.transaction(() => {
      for (const collection of STORAGE_COLLECTIONS) {
        const collectionData = (data as Record<string, unknown>)[collection];
        if (collectionData !== undefined) {
          stmt.run(userId, collection, JSON.stringify(collectionData));
        }
      }
    });
    tx();
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.ensureDb();
    this.db!.prepare("INSERT OR IGNORE INTO audit_events (id, ts, type, data) VALUES (?, ?, ?, ?)").run(
      event.id,
      event.timestamp,
      event.type,
      JSON.stringify(event),
    );
  }

  /** The WHERE the filter asks for (docs/CONTEXT.md §4.27), the JSON fields read with json_extract. */
  private auditWhere(filter: AuditEventFilter | undefined): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      clauses.push(sql);
      params.push(value);
    };
    if (filter?.type) add("type = ?", filter.type);
    if (filter?.actor) add("json_extract(data, '$.user') = ?", filter.actor);
    if (filter?.connectionName) add("json_extract(data, '$.connectionName') = ?", filter.connectionName);
    if (filter?.result) add("json_extract(data, '$.result') = ?", filter.result);
    if (filter?.from) add("ts >= ?", filter.from);
    if (filter?.to) add("ts <= ?", filter.to);
    return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEvent[]> {
    this.ensureDb();
    const where = this.auditWhere(query);
    const rows = this.db!.prepare(`SELECT data FROM audit_events${where.sql} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(
      ...where.params,
      query.limit,
      query.offset ?? 0,
    ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as AuditEvent);
  }

  async countAuditEvents(filter?: AuditEventFilter): Promise<number> {
    this.ensureDb();
    const where = this.auditWhere(filter);
    const row = this.db!.prepare(`SELECT COUNT(*) AS n FROM audit_events${where.sql}`).get(...where.params) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  async pruneAuditEvents(before: string): Promise<number> {
    this.ensureDb();
    const result = this.db!.prepare("DELETE FROM audit_events WHERE ts < ?").run(before);
    return Number(result.changes ?? 0);
  }

  async putApproval(record: ApprovalRequest): Promise<void> {
    this.ensureDb();
    this.db!.prepare(
      "INSERT OR REPLACE INTO approval_requests (id, ts, status, requester, datasource_id, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(record.id, record.requestedAt, record.status, record.requester, record.datasourceId, JSON.stringify(record));
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    this.ensureDb();
    const row = this.db!.prepare("SELECT data FROM approval_requests WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as ApprovalRequest) : null;
  }

  async listApprovals(query: ApprovalQuery): Promise<ApprovalRequest[]> {
    this.ensureDb();
    const { where, params } = approvalFilter(query);
    const rows = this.db!.prepare(`SELECT data FROM approval_requests${where} ORDER BY ts DESC LIMIT ?`).all(
      ...params,
      query.limit,
    ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as ApprovalRequest);
  }

  async putJob(record: JobRecord): Promise<void> {
    this.ensureDb();
    this.db!.prepare(
      "INSERT OR REPLACE INTO jobs (id, kind, status, run_at, lease_until, attempts, max_attempts, worker, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.kind,
      record.status,
      record.runAt,
      record.leaseUntil ?? null,
      record.attempts,
      record.maxAttempts,
      record.worker ?? null,
      JSON.stringify(record),
    );
  }

  async getJob(id: string): Promise<JobRecord | null> {
    this.ensureDb();
    const row = this.db!.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  async listJobs(query: JobQuery): Promise<JobRecord[]> {
    this.ensureDb();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.kind) {
      clauses.push("kind = ?");
      params.push(query.kind);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db!.prepare(`SELECT ${JOB_COLUMNS} FROM jobs${where} ORDER BY run_at DESC LIMIT ?`).all(
      ...params,
      query.limit,
    ) as JobRow[];
    return rows.map(jobFromRow);
  }

  async countJobs(status: JobStatus): Promise<number> {
    this.ensureDb();
    const row = this.db!.prepare("SELECT count(*) AS n FROM jobs WHERE status = ?").get(status) as { n: number };
    return Number(row?.n ?? 0);
  }

  async claimJob(kinds: string[], worker: string, now: string, leaseUntil: string): Promise<JobRecord | null> {
    this.ensureDb();
    const claim = this.db!.transaction((): JobRow | undefined => {
      const marks = kinds.map(() => "?").join(", ");
      const row = this.db!.prepare(
        `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'queued' AND run_at <= ? AND kind IN (${marks}) ORDER BY run_at LIMIT 1`,
      ).get(now, ...kinds) as JobRow | undefined;
      if (!row) return undefined;
      this.db!.prepare(
        "UPDATE jobs SET status = 'running', lease_until = ?, attempts = attempts + 1, worker = ? WHERE id = ?",
      ).run(leaseUntil, worker, row.id);
      return { ...row, status: "running", lease_until: leaseUntil, attempts: Number(row.attempts) + 1, worker };
    });
    const row = claim();
    return row ? jobFromRow(row) : null;
  }

  async heartbeatJob(id: string, worker: string, leaseUntil: string): Promise<boolean> {
    this.ensureDb();
    const result = this.db!.prepare(
      "UPDATE jobs SET lease_until = ? WHERE id = ? AND worker = ? AND status = 'running'",
    ).run(leaseUntil, id, worker);
    return Number(result.changes ?? 0) > 0;
  }

  async reclaimJobs(now: string): Promise<JobRecord[]> {
    this.ensureDb();
    const expired = this.db!.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'running' AND lease_until < ?`,
    ).all(now) as JobRow[];
    const out: JobRecord[] = [];
    for (const row of expired) {
      const status: JobStatus = Number(row.attempts) >= Number(row.max_attempts) ? "lost" : "queued";
      this.db!.prepare("UPDATE jobs SET status = ?, lease_until = NULL, worker = NULL WHERE id = ?").run(
        status,
        row.id,
      );
      out.push(jobFromRow({ ...row, status, lease_until: null, worker: null }));
    }
    return out;
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensureDb();
      const result = this.db!.prepare("SELECT 1 as ok").get() as { ok: number };
      return result?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): void {
    if (!this.db) {
      throw new Error("SQLite storage not initialized. Call initialize() first.");
    }
  }
}

/** The optional filters of an approval query as one WHERE clause with positional params. */
function approvalFilter(query: ApprovalQuery): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.status) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.requester) {
    clauses.push("requester = ?");
    params.push(query.requester);
  }
  if (query.datasourceId) {
    clauses.push("datasource_id = ?");
    params.push(query.datasourceId);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}
