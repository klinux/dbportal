import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "pg";
import { PostgresStorageProvider } from "@/lib/storage/providers/postgres";

/**
 * The partitioned audit record on a real PostgreSQL (docs/CONTEXT.md §4.43): an install
 * with the plain table from before has it attached as the legacy partition with its rows
 * in place; the next periods' partitions exist after initialize; an instant no partition
 * holds gets one on the spot; retention deletes old rows from the legacy partition and
 * drops a partition whole once it is wholly past; initialize is idempotent. Skipped without
 * DBPORTAL_IT_PG_URL, like the route suite; CI provides one.
 */
const URL_ = process.env.DBPORTAL_IT_PG_URL ?? "";
const DB = "it_audit";

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: URL_ });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
function dbUrl(): string {
  const u = new URL(URL_);
  u.pathname = `/${DB}`;
  return u.toString();
}
async function inDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
const event = (id: string, ts: string) => ({
  id,
  timestamp: ts,
  type: "query_execution" as const,
  action: "query",
  target: "POST /api/db/query",
  user: "ana",
  result: "success" as const,
});
const thisMonth = new Date();
const inThisMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth(), 2, 12)).toISOString();
const nextMonthStart = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() + 1, 1)).toISOString();

describe.skipIf(!URL_)("the partitioned audit record on PostgreSQL", () => {
  let provider: PostgresStorageProvider;

  beforeAll(async () => {
    delete process.env.AUDIT_PARTITION;
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${DB}`);
    });
    // The table as every install before §4.43 made it, with rows from last year and from this month.
    await inDb(async (c) => {
      await c.query(
        "CREATE TABLE audit_events (id TEXT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
      );
      await c.query("CREATE INDEX audit_events_ts ON audit_events (ts DESC)");
      await c.query("CREATE INDEX audit_events_type_ts ON audit_events (type, ts DESC)");
      for (const [id, ts] of [
        ["old-1", "2025-03-01T00:00:00.000Z"],
        ["old-2", "2025-11-15T00:00:00.000Z"],
        ["cur-1", inThisMonth],
      ]) {
        await c.query("INSERT INTO audit_events (id, ts, type, data) VALUES ($1, $2, 'query_execution', $3)", [
          id,
          ts,
          JSON.stringify(event(id, ts)),
        ]);
      }
    });
    provider = new PostgresStorageProvider(dbUrl());
    await provider.initialize();
  });

  afterAll(async () => {
    await provider?.close();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
  });

  const partitions = () =>
    inDb(async (c) => {
      const { rows } = await c.query(
        `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'audit_events' ORDER BY c.relname`,
      );
      return rows as { name: string; bound: string }[];
    });

  test("the plain table became the legacy partition, rows in place, and the next periods have partitions", async () => {
    const kind = await inDb(
      async (c) => (await c.query("SELECT relkind FROM pg_class WHERE relname = 'audit_events'")).rows[0].relkind,
    );
    expect(kind).toBe("p");
    const parts = await partitions();
    expect(parts.map((p) => p.name)).toContain("audit_events_legacy");
    expect(parts.find((p) => p.name === "audit_events_legacy")?.bound).toContain("FROM (MINVALUE)");
    // The legacy partition reaches to the end of this period, so this period's rows stay where they are
    // and the parent's own partitions begin with the next two.
    expect(parts.filter((p) => p.name !== "audit_events_legacy")).toHaveLength(2);
    expect(await provider.countAuditEvents()).toBe(3);
    expect((await provider.listAuditEvents({ limit: 10 })).map((e) => e.id)).toEqual(["cur-1", "old-2", "old-1"]);
    // Again is a no-op: the same partitions, nothing renamed twice.
    await provider.initialize();
    expect((await partitions()).length).toBe(3);
  });

  test("an append lands in its period, and an instant with no partition gets one made on the spot", async () => {
    // The same event twice - the same id and instant - lands once.
    const now = new Date().toISOString();
    await provider.appendAuditEvent(event("now-1", now));
    await provider.appendAuditEvent(event("now-1", now));
    expect(await provider.countAuditEvents({ actor: "ana" })).toBe(4);
    const far = "2030-06-15T12:00:00.000Z";
    await provider.appendAuditEvent(event("far-1", far));
    expect((await partitions()).map((p) => p.name)).toContain("audit_events_p2030_06");
    expect((await provider.listAuditEvents({ limit: 1 }))[0].id).toBe("far-1");
  });

  test("retention deletes old rows from the legacy partition, then drops it whole; a partition wholly past is dropped", async () => {
    const first = await provider.maintainAuditStorage(new Date(), "2026-01-01T00:00:00.000Z");
    expect(first.dropped).toEqual([]);
    expect(first.removed).toBe(2);
    expect(await provider.countAuditEvents({ actor: "ana" })).toBe(3);
    const second = await provider.maintainAuditStorage(new Date(), nextMonthStart);
    expect(second.dropped).toContain("audit_events_legacy");
    expect((await partitions()).map((p) => p.name)).not.toContain("audit_events_legacy");
    // The far-future row is in a partition of its own, which a retention past it drops whole.
    const third = await provider.maintainAuditStorage(new Date(), "2031-01-01T00:00:00.000Z");
    expect(third.dropped).toContain("audit_events_p2030_06");
    expect(await provider.countAuditEvents({ actor: "ana" })).toBe(0);
  });
});
