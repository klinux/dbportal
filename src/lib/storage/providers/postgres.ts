/**
 * PostgreSQL Server Storage Provider
 * Uses the existing `pg` package (already a project dependency).
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
  LeaseRecord,
  AuditMaintenance,
} from "../types";
import type { AuditEvent } from "@/lib/audit";
import { splitPgUrl, sslFromMode } from "@/lib/db/pg-ssl";
import { STORAGE_COLLECTIONS } from "../types";
import {
  AUDIT_TABLE,
  LEGACY_PARTITION,
  type PartitionBounds,
  covers,
  parseBounds,
  partitionKind,
  periodOf,
  periodsAhead,
  tsLiteral,
} from "../audit-partitions";
import { logger } from "@/lib/logger";

let Pool: typeof import("pg").Pool;

const JOB_COLUMNS = "id, kind, status, run_at, lease_until, attempts, max_attempts, worker, data";
/** Below this many rows the exact count is cheap and the estimate coarse; above, the estimate serves the page. */
export const COUNT_ESTIMATE_FROM = 100_000;

/** The record as JSON, with the columns a worker changes laid over it. */
function jobFromRow(row: Record<string, unknown>): JobRecord {
  const record = JSON.parse(String(row.data)) as JobRecord;
  const instant = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? undefined : String(v));
  return {
    ...record,
    status: String(row.status) as JobStatus,
    runAt: instant(row.run_at) ?? record.runAt,
    leaseUntil: instant(row.lease_until),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    worker: row.worker == null ? undefined : String(row.worker),
  };
}

export class PostgresStorageProvider implements ServerStorageProvider {
  private pool: InstanceType<typeof import("pg").Pool> | null = null;
  private connectionString: string;

  constructor(connectionString?: string) {
    this.connectionString = connectionString || process.env.STORAGE_POSTGRES_URL || "";
  }

  async initialize(): Promise<void> {
    if (!this.connectionString) {
      throw new Error("STORAGE_POSTGRES_URL is required when STORAGE_PROVIDER=postgres");
    }

    // Dynamic import to avoid requiring pg when not needed
    if (!Pool) {
      const pg = await import("pg");
      Pool = pg.Pool;
    }

    // The URL without its TLS parameters: the driver would otherwise read them after the
    // explicit `ssl` below and let them win (§4.47), and its reading of `require` verifies.
    this.pool = new Pool({
      connectionString: splitPgUrl(this.connectionString).url,
      max: 5,
      idleTimeoutMillis: 30000,
      ssl: this.buildSSLConfig(),
    });

    // An idle client the server drops has no query to reject, so `pg` destroys it and
    // emits on the pool; an `error` event with no listener is an uncaught exception. This
    // pool is long-lived and serves every request while STORAGE_PROVIDER=postgres, so
    // without this handler a dropped idle connection crashes the server (#298). The
    // client is already gone — log it and let the pool open a fresh one on next acquire.
    this.pool.on("error", (error: unknown) => {
      logger.error("PostgreSQL storage pool client error", error, { provider: "postgres" });
    });

    // Create table
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_storage (
          user_id    TEXT NOT NULL,
          collection TEXT NOT NULL,
          data       TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, collection)
        )
      `);
      // The audit record (docs/CONTEXT.md §4.2): one row per event, the sanitized event as
      // JSON, and the two columns the admin API filters and orders on. Append-only by
      // contract - nothing in this provider updates or deletes a row. Partitioned by period
      // on ts (§4.43), so retention drops a partition instead of deleting rows; the primary
      // key carries ts because a partitioned unique index must include the partition key.
      await this.migrateAuditTable();
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id   TEXT NOT NULL,
          ts   TIMESTAMPTZ NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (ts, id)
        ) PARTITION BY RANGE (ts)
      `);
      await this.pool.query("CREATE INDEX IF NOT EXISTS audit_events_ts ON audit_events (ts DESC)");
      // The admin page's filters (docs/CONTEXT.md §4.27): the actor and the datasource live in
      // the JSON, so each gets an expression index; the type has the column.
      await this.pool.query("CREATE INDEX IF NOT EXISTS audit_events_type_ts ON audit_events (type, ts DESC)");
      await this.pool.query("CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events ((data::jsonb->>'user'))");
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS audit_events_connection ON audit_events ((data::jsonb->>'connectionName'))",
      );
      // Write approvals (docs/CONTEXT.md §4.6); see the SQLite provider for the shape.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id            TEXT PRIMARY KEY,
          ts            TIMESTAMPTZ NOT NULL,
          status        TEXT NOT NULL,
          requester     TEXT NOT NULL,
          datasource_id TEXT NOT NULL,
          data          TEXT NOT NULL
        )
      `);
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS approval_requests_lookup ON approval_requests (datasource_id, requester, status)",
      );
      // The job queue (docs/CONTEXT.md §4.40): the columns a worker claims and leases by,
      // the rest of the record as JSON. Claimed with SKIP LOCKED, so workers never collide.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL,
          status       TEXT NOT NULL,
          run_at       TIMESTAMPTZ NOT NULL,
          lease_until  TIMESTAMPTZ,
          attempts     INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 1,
          worker       TEXT,
          data         TEXT NOT NULL
        )
      `);
      await this.pool.query("CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, run_at)");
      // Leases (§4.41): one row per name, taken with an upsert whose WHERE decides, so the
      // database arbitrates between instances that ask at the same instant.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS leases (
          name       TEXT PRIMARY KEY,
          holder     TEXT NOT NULL,
          held_until TIMESTAMPTZ NOT NULL
        )
      `);
      await this.ensureAuditPartitions(new Date());
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not support SSL")) {
        throw new Error(
          "PostgreSQL storage connection failed: server does not support SSL. Add ?sslmode=disable to STORAGE_POSTGRES_URL for local PostgreSQL.",
          { cause: error },
        );
      }
      logger.error("PostgreSQL storage initialization failed", error, { provider: "postgres" });
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT collection, data FROM user_storage WHERE user_id = $1", [userId]);

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(row.data);
      } catch {
        logger.warn("Skipping corrupted storage data", { provider: "postgres", collection: row.collection });
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT data FROM user_storage WHERE user_id = $1 AND collection = $2", [
      userId,
      collection,
    ]);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].data) as StorageData[K];
    } catch {
      logger.warn("Corrupted data in storage collection", { provider: "postgres", collection });
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    this.ensurePool();
    await this.pool!.query(
      `INSERT INTO user_storage (user_id, collection, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, collection)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [userId, collection, JSON.stringify(data)],
    );
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    this.ensurePool();
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      for (const collection of STORAGE_COLLECTIONS) {
        const collectionData = (data as Record<string, unknown>)[collection];
        if (collectionData !== undefined) {
          await client.query(
            `INSERT INTO user_storage (user_id, collection, data, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, collection)
             DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [userId, collection, JSON.stringify(collectionData)],
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * An install from before §4.43 has a plain `audit_events`: it becomes the legacy
   * partition of the new parent, attached with no copy, holding everything up to the end
   * of the current period (its rows reach into it), so the parent's own partitions start
   * with the next. Its indexes and constraint are renamed out of the parent's way first.
   */
  private async migrateAuditTable(): Promise<void> {
    const { rows } = await this.pool!.query(
      "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = current_schema()",
      [AUDIT_TABLE],
    );
    if (rows.length === 0 || String(rows[0].relkind) !== "r") return;
    const upTo = periodOf(new Date(), partitionKind()).to;
    logger.info("Audit table becomes the legacy partition of a partitioned one", { route: "storage", upTo });
    await this.pool!.query("BEGIN");
    try {
      await this.pool!.query(`ALTER TABLE ${AUDIT_TABLE} RENAME TO ${LEGACY_PARTITION}`);
      for (const index of [
        "audit_events_ts",
        "audit_events_type_ts",
        "audit_events_actor",
        "audit_events_connection",
      ]) {
        await this.pool!.query(
          `ALTER INDEX IF EXISTS ${index} RENAME TO ${index.replace("audit_events", LEGACY_PARTITION)}`,
        );
      }
      // The parent's key is (ts, id) and a partition cannot keep a primary key of its own:
      // the old one goes, and the attach gives the partition the parent's. An id is minted
      // with its instant, so (ts, id) is as unique as id was.
      await this.pool!.query(`ALTER TABLE ${LEGACY_PARTITION} DROP CONSTRAINT IF EXISTS audit_events_pkey`);
      await this.pool!.query(`
        CREATE TABLE ${AUDIT_TABLE} (
          id   TEXT NOT NULL,
          ts   TIMESTAMPTZ NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (ts, id)
        ) PARTITION BY RANGE (ts)
      `);
      await this.pool!.query(
        `ALTER TABLE ${AUDIT_TABLE} ATTACH PARTITION ${LEGACY_PARTITION} FOR VALUES FROM (MINVALUE) TO (${tsLiteral(upTo)})`,
      );
      await this.pool!.query("COMMIT");
    } catch (error) {
      await this.pool!.query("ROLLBACK");
      throw error;
    }
  }

  /** Every partition of the audit record with its bounds, the legacy one included. */
  private async auditPartitions(): Promise<PartitionBounds[]> {
    const { rows } = await this.pool!.query(
      `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = $1 ORDER BY c.relname`,
      [AUDIT_TABLE],
    );
    return rows
      .map((row: { name: string; bound: string }) => parseBounds(String(row.name), String(row.bound)))
      .filter((b: PartitionBounds | null): b is PartitionBounds => b !== null);
  }

  /** The partitions for `now`'s period and the next ones, where none holds them yet. */
  async ensureAuditPartitions(now: Date): Promise<string[]> {
    this.ensurePool();
    const existing = await this.auditPartitions();
    const created: string[] = [];
    for (const period of periodsAhead(now, partitionKind())) {
      if (existing.some((b) => covers(b, period.from))) continue;
      await this.pool!.query(
        `CREATE TABLE IF NOT EXISTS ${period.name} PARTITION OF ${AUDIT_TABLE} FOR VALUES FROM (${tsLiteral(period.from)}) TO (${tsLiteral(period.to)})`,
      );
      created.push(period.name);
    }
    return created;
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.ensurePool();
    const insert = () =>
      this.pool!.query(
        "INSERT INTO audit_events (id, ts, type, data) VALUES ($1, $2, $3, $4) ON CONFLICT (ts, id) DO NOTHING",
        [event.id, event.timestamp, event.type, JSON.stringify(event)],
      );
    try {
      await insert();
    } catch (error) {
      // No partition for the instant (a boundary the upkeep did not reach): made now, then the row.
      if (!/no partition of relation/i.test((error as Error).message)) throw error;
      await this.ensureAuditPartitions(new Date(event.timestamp));
      await insert();
    }
  }

  /** The planner's row estimate over the partitions; -1 when one was never analyzed. */
  private async auditEstimate(): Promise<number> {
    const { rows } = await this.pool!.query(
      `SELECT COALESCE(SUM(c.reltuples), 0)::bigint AS n, BOOL_OR(c.reltuples < 0) AS unknown
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = $1`,
      [AUDIT_TABLE],
    );
    return rows[0]?.unknown ? -1 : Number(rows[0]?.n ?? 0);
  }

  async maintainAuditStorage(now: Date, retainBefore: string | null): Promise<AuditMaintenance> {
    this.ensurePool();
    const created = await this.ensureAuditPartitions(now);
    const { dropped, removed } = retainBefore
      ? await this.pruneAuditPartitions(retainBefore)
      : { dropped: [], removed: 0 };
    return { created, dropped, removed };
  }

  /**
   * Retention (§4.12, §4.43): a partition wholly before the instant is dropped, which is
   * instant and leaves no bloat; the legacy partition, which reaches into the present, has
   * its old rows deleted until it can go whole.
   */
  private async pruneAuditPartitions(before: string): Promise<{ dropped: string[]; removed: number }> {
    const dropped: string[] = [];
    let removed = 0;
    for (const partition of await this.auditPartitions()) {
      if (partition.to <= before) {
        await this.pool!.query(`DROP TABLE IF EXISTS ${partition.name}`);
        dropped.push(partition.name);
      } else if (partition.from === null) {
        const result = await this.pool!.query(`DELETE FROM ${partition.name} WHERE ts < $1`, [before]);
        removed += result.rowCount ?? 0;
      }
    }
    return { dropped, removed };
  }

  /** The WHERE the filter asks for, with its bound values, or none. */
  private auditWhere(filter: AuditEventFilter | undefined): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace("?", `$${params.length}`));
    };
    if (filter?.type) add("type = ?", filter.type);
    if (filter?.actor) add("data::jsonb->>'user' = ?", filter.actor);
    if (filter?.connectionName) add("data::jsonb->>'connectionName' = ?", filter.connectionName);
    if (filter?.result) add("data::jsonb->>'result' = ?", filter.result);
    if (filter?.from) add("ts >= ?", filter.from);
    if (filter?.to) add("ts <= ?", filter.to);
    return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEvent[]> {
    this.ensurePool();
    const where = this.auditWhere(query);
    const n = where.params.length;
    const { rows } = await this.pool!.query(
      `SELECT data FROM audit_events${where.sql} ORDER BY ts DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...where.params, query.limit, query.offset ?? 0],
    );
    return rows.map((row: { data: string }) => JSON.parse(row.data) as AuditEvent);
  }

  async countAuditEvents(filter?: AuditEventFilter): Promise<number> {
    this.ensurePool();
    const where = this.auditWhere(filter);
    // Without a filter the page shows a total, and the planner's estimate is that total
    // to within a fraction of a percent once the table is large - an exact count would
    // walk every partition on every page.
    if (where.params.length === 0) {
      const estimate = await this.auditEstimate();
      if (estimate >= COUNT_ESTIMATE_FROM) return estimate;
    }
    const { rows } = await this.pool!.query(`SELECT COUNT(*)::int AS n FROM audit_events${where.sql}`, where.params);
    return rows[0]?.n ?? 0;
  }

  async pruneAuditEvents(before: string): Promise<number> {
    this.ensurePool();
    const { dropped, removed } = await this.pruneAuditPartitions(before);
    return removed + dropped.length;
  }

  async putApproval(record: ApprovalRequest): Promise<void> {
    this.ensurePool();
    await this.pool!.query(
      `INSERT INTO approval_requests (id, ts, status, requester, datasource_id, data) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
      [record.id, record.requestedAt, record.status, record.requester, record.datasourceId, JSON.stringify(record)],
    );
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT data FROM approval_requests WHERE id = $1", [id]);
    return rows[0] ? (JSON.parse(rows[0].data) as ApprovalRequest) : null;
  }

  async listApprovals(query: ApprovalQuery): Promise<ApprovalRequest[]> {
    this.ensurePool();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["status", query.status],
      ["requester", query.requester],
      ["datasource_id", query.datasourceId],
    ] as const) {
      if (!value) continue;
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
    params.push(query.limit);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool!.query(
      `SELECT data FROM approval_requests${where} ORDER BY ts DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((row: { data: string }) => JSON.parse(row.data) as ApprovalRequest);
  }

  async putJob(record: JobRecord): Promise<void> {
    this.ensurePool();
    await this.pool!.query(
      `INSERT INTO jobs (id, kind, status, run_at, lease_until, attempts, max_attempts, worker, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, run_at = EXCLUDED.run_at, lease_until = EXCLUDED.lease_until,
         attempts = EXCLUDED.attempts, max_attempts = EXCLUDED.max_attempts, worker = EXCLUDED.worker, data = EXCLUDED.data`,
      [
        record.id,
        record.kind,
        record.status,
        record.runAt,
        record.leaseUntil ?? null,
        record.attempts,
        record.maxAttempts,
        record.worker ?? null,
        JSON.stringify(record),
      ],
    );
  }

  async getJob(id: string): Promise<JobRecord | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [id]);
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async listJobs(query: JobQuery): Promise<JobRecord[]> {
    this.ensurePool();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["status", query.status],
      ["kind", query.kind],
    ] as const) {
      if (!value) continue;
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
    params.push(query.limit);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool!.query(
      `SELECT ${JOB_COLUMNS} FROM jobs${where} ORDER BY run_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(jobFromRow);
  }

  async countJobs(status: JobStatus): Promise<number> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT count(*)::int AS n FROM jobs WHERE status = $1", [status]);
    return Number(rows[0]?.n ?? 0);
  }

  async claimJob(kinds: string[], worker: string, now: string, leaseUntil: string): Promise<JobRecord | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `UPDATE jobs SET status = 'running', lease_until = $2, attempts = attempts + 1, worker = $3
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'queued' AND run_at <= $1 AND kind = ANY($4)
         ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING ${JOB_COLUMNS}`,
      [now, leaseUntil, worker, kinds],
    );
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async acquireLease(name: string, holder: string, now: string, until: string): Promise<boolean> {
    this.ensurePool();
    const result = await this.pool!.query(
      `INSERT INTO leases (name, holder, held_until) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, held_until = EXCLUDED.held_until
       WHERE leases.held_until < $4 OR leases.holder = EXCLUDED.holder
       RETURNING name`,
      [name, holder, until, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listLeases(): Promise<LeaseRecord[]> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT name, holder, held_until FROM leases ORDER BY name");
    return rows.map((row) => ({
      name: String(row.name),
      holder: String(row.holder),
      until: row.held_until instanceof Date ? row.held_until.toISOString() : String(row.held_until),
    }));
  }

  async pruneJobs(before: string): Promise<number> {
    this.ensurePool();
    const result = await this.pool!.query(
      "DELETE FROM jobs WHERE status IN ('done', 'failed', 'lost') AND run_at < $1",
      [before],
    );
    return result.rowCount ?? 0;
  }

  async heartbeatJob(id: string, worker: string, leaseUntil: string): Promise<boolean> {
    this.ensurePool();
    const result = await this.pool!.query(
      "UPDATE jobs SET lease_until = $3 WHERE id = $1 AND worker = $2 AND status = 'running'",
      [id, worker, leaseUntil],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reclaimJobs(now: string): Promise<JobRecord[]> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'lost' ELSE 'queued' END, lease_until = NULL, worker = NULL
       WHERE status = 'running' AND lease_until < $1
       RETURNING ${JOB_COLUMNS}`,
      [now],
    );
    return rows.map(jobFromRow);
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensurePool();
      const { rows } = await this.pool!.query("SELECT 1 as ok");
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensurePool(): void {
    if (!this.pool) {
      throw new Error("PostgreSQL storage not initialized. Call initialize() first.");
    }
  }

  private buildSSLConfig(): boolean | { rejectUnauthorized: boolean } {
    const { mode, ssl, host } = splitPgUrl(this.connectionString);
    // The URL's own word first (docs/STORAGE.md "Using an Existing PostgreSQL"): `require`
    // encrypts without checking the chain, the verify-* modes check it against the runtime's
    // roots - this pool has no channel for a CA PEM. Then the `ssl=` shorthand, then the
    // host: a local one plain, anything else encrypted and unchecked.
    const fromMode = sslFromMode(mode);
    if (fromMode !== null) return fromMode;
    if (ssl === false) return false;
    if (ssl === true) return { rejectUnauthorized: false };
    if (this.isLocalHost(host)) return false;
    return { rejectUnauthorized: false };
  }

  private isLocalHost(host: string): boolean {
    const localHosts = new Set([
      "localhost",
      "::1",
      "host.docker.internal",
      "docker.for.mac.localhost",
      "docker.for.win.localhost",
      "gateway.docker.internal",
    ]);
    if (localHosts.has(host)) return true;
    if (host.startsWith("127.")) return true;
    return false;
  }
}
