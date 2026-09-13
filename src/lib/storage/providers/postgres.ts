/**
 * PostgreSQL Server Storage Provider
 * Uses the existing `pg` package (already a project dependency).
 */

import type { AuditEventQuery, ServerStorageProvider, StorageCollection, StorageData } from "../types";
import type { AuditEvent } from "@/lib/audit";
import { STORAGE_COLLECTIONS } from "../types";
import { logger } from "@/lib/logger";

let Pool: typeof import("pg").Pool;

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

    this.pool = new Pool({
      connectionString: this.connectionString,
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
      // contract - nothing in this provider updates or deletes a row.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id   TEXT PRIMARY KEY,
          ts   TIMESTAMPTZ NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL
        )
      `);
      await this.pool.query("CREATE INDEX IF NOT EXISTS audit_events_ts ON audit_events (ts DESC)");
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

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.ensurePool();
    await this.pool!.query(
      "INSERT INTO audit_events (id, ts, type, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
      [event.id, event.timestamp, event.type, JSON.stringify(event)],
    );
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEvent[]> {
    this.ensurePool();
    const { rows } = query.type
      ? await this.pool!.query("SELECT data FROM audit_events WHERE type = $1 ORDER BY ts DESC LIMIT $2", [
          query.type,
          query.limit,
        ])
      : await this.pool!.query("SELECT data FROM audit_events ORDER BY ts DESC LIMIT $1", [query.limit]);
    return rows.map((row: { data: string }) => JSON.parse(row.data) as AuditEvent);
  }

  async countAuditEvents(): Promise<number> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT COUNT(*)::int AS n FROM audit_events");
    return rows[0]?.n ?? 0;
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
    const { host, searchParams } = this.parseConnectionString(this.connectionString);

    const sslMode = searchParams.get("sslmode")?.toLowerCase();
    if (sslMode === "disable") return false;
    // `verify-system` is not a libpq sslmode - it is this product's own mode name
    // (src/lib/types.ts), and someone configuring STORAGE_POSTGRES_URL from the connection
    // form's vocabulary will write it. It means "verify against the runtime's trust store",
    // so it is the one value here that turns verification ON; without this branch it fell
    // through to the non-local default below and got `rejectUnauthorized: false`, i.e. the
    // opposite of what it says (D26). The libpq spellings keep their existing behaviour: this
    // pool has no channel for a CA PEM, so a verifying default would break every deployment
    // whose storage database presents a self-signed certificate.
    if (sslMode === "verify-system") return { rejectUnauthorized: true };
    if (sslMode === "require" || sslMode === "prefer" || sslMode === "verify-ca" || sslMode === "verify-full") {
      return { rejectUnauthorized: false };
    }

    const sslParam = searchParams.get("ssl")?.toLowerCase();
    if (sslParam === "false" || sslParam === "0" || sslParam === "no") {
      return false;
    }
    if (sslParam === "true" || sslParam === "1" || sslParam === "yes") {
      return { rejectUnauthorized: false };
    }

    if (this.isLocalHost(host)) return false;
    return { rejectUnauthorized: false };
  }

  private parseConnectionString(connectionString: string): {
    host: string;
    searchParams: URLSearchParams;
  } {
    try {
      const parsed = new URL(connectionString);
      return {
        host: parsed.hostname.toLowerCase(),
        searchParams: parsed.searchParams,
      };
    } catch {
      return {
        host: "",
        searchParams: new URLSearchParams(),
      };
    }
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
