import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ColumnSpec, TableSpec } from "@/lib/seed-data/catalog";

/**
 * The seed job (docs/CONTEXT.md §4.23): the guard (engine, production, freeze), one job per
 * datasource at a time, the tables filled in order with bound rows in batches, the keys the
 * engine returns pooled for the next table's foreign keys, TRUNCATE when asked, a failure
 * kept on its table, and the two audit lines. The runner is a mock; nothing opens a database.
 */
const audit = mock((_event: Record<string, unknown>) => ({}));
const auditedAt = (i: number) => (audit.mock.calls as unknown[][])[i]?.[0] as Record<string, unknown>;
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
let frozen: { reason: string; until: string } | null = null;
mock.module("@/lib/freezes/store", () => ({ activeFreeze: async () => frozen }));

const { MAX_BATCH_ROWS, assertSeedable, getSeedRun, resetSeedRuns, seedAllowed, startSeedRun } = await import(
  "@/lib/seed-data/run"
);

const col = (name: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  dataType: "integer",
  udt: "int4",
  nullable: false,
  hasDefault: false,
  engineFilled: false,
  identity: false,
  maxLength: null,
  numericPrecision: null,
  numericScale: null,
  primaryKey: false,
  unique: false,
  ...over,
});
const customers: TableSpec = {
  name: "customers",
  columns: [
    col("id", { identity: true, hasDefault: true, engineFilled: true, primaryKey: true, unique: true }),
    col("email", { udt: "varchar", unique: true }),
  ],
};
const orders: TableSpec = {
  name: "orders",
  columns: [
    col("id", { identity: true, hasDefault: true, engineFilled: true, primaryKey: true, unique: true }),
    col("customer_id", { references: { table: "customers", column: "id" } }),
    col("created_at", { udt: "timestamptz", hasDefault: true, engineFilled: true }),
    col("status", { udt: "text", hasDefault: true }),
  ],
};
const connection = {
  id: "seed:stage",
  seedId: "stage",
  name: "Stage",
  type: "postgres",
  environment: "staging",
} as never;

let nextId = 0;
const calls: { sql: string; params: unknown[] | undefined }[] = [];
const runner = {
  query: mock(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.startsWith("TRUNCATE")) return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
    if (sql.includes('"orders"') && sql.includes("boom")) throw new Error("duplicate key");
    const count = (sql.match(/\(\$/g) ?? []).length || Number(sql.match(/generate_series\(1, (\d+)\)/)?.[1] ?? 0);
    const rows = sql.includes("RETURNING") ? Array.from({ length: count }, () => ({ id: ++nextId })) : [];
    return { rows, fields: ["id"], rowCount: count, executionTime: 1 };
  }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("seed-data run", () => {
  beforeEach(() => {
    resetSeedRuns();
    audit.mockClear();
    calls.length = 0;
    nextId = 0;
    frozen = null;
  });

  test("the guard: PostgreSQL only, never production, never inside a freeze window", async () => {
    expect(seedAllowed({ type: "mysql", environment: "staging" })).toContain("PostgreSQL");
    expect(seedAllowed({ type: "postgres", environment: "production" })).toContain("production");
    expect(seedAllowed({ type: "postgres", environment: "staging" })).toBeNull();
    await expect(assertSeedable(connection)).resolves.toBeUndefined();
    frozen = { reason: "Release", until: "2026-09-15T00:00:00.000Z" };
    const err = await assertSeedable(connection).catch((e) => e);
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain("frozen");
  });

  test("fills parents then children in bound batches, pools the returned keys, and reports done with two audit lines", async () => {
    const counts = new Map([
      ["customers", 3],
      ["orders", MAX_BATCH_ROWS + 2],
    ]);
    const run = startSeedRun({
      connection,
      runner,
      schema: "public",
      tables: [orders, customers],
      counts,
      truncate: false,
      actor: "root",
    });
    expect(run.status).toBe("running");
    expect(run.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    expect(auditedAt(0)).toMatchObject({
      type: "data_seed",
      action: "started",
      target: "stage",
      details: `2 tables, ${MAX_BATCH_ROWS + 5} rows`,
    });
    await settle();
    const done = getSeedRun(run.id)!;
    expect(done.status).toBe("done");
    expect(done.tables).toEqual([
      { name: "customers", target: 3, inserted: 3 },
      { name: "orders", target: MAX_BATCH_ROWS + 2, inserted: MAX_BATCH_ROWS + 2 },
    ]);
    // customers: one batch of three bound rows, identity id omitted, key returned.
    expect(calls[0].sql).toBe('INSERT INTO "public"."customers" ("email") VALUES ($1), ($2), ($3) RETURNING "id"');
    expect(calls[0].params).toHaveLength(3);
    // orders: two batches; created_at (a call default) omitted, status (a constant default) still
    // generated; every customer_id from the pool.
    expect(
      calls[1].sql.startsWith('INSERT INTO "public"."orders" ("customer_id", "status") VALUES ($1, $2), ($3, $4)'),
    ).toBe(true);
    expect(calls[1].sql.endsWith(`($${MAX_BATCH_ROWS * 2 - 1}, $${MAX_BATCH_ROWS * 2})`)).toBe(true);
    expect(calls[2].sql).toBe('INSERT INTO "public"."orders" ("customer_id", "status") VALUES ($1, $2), ($3, $4)');
    for (const v of [...calls[1].params!, ...calls[2].params!].filter((_v, i) => i % 2 === 0))
      expect([1, 2, 3]).toContain(v as number);
    expect(auditedAt(1)).toMatchObject({
      type: "data_seed",
      action: "finished",
      result: "success",
      rows: MAX_BATCH_ROWS + 5,
      details: `${MAX_BATCH_ROWS + 5} rows into 2 tables`,
    });
  });

  test("empties the tables first when asked, keeps a failure on its table, goes on with the rest, and reports failed", async () => {
    const boom: TableSpec = { name: "orders", columns: [...orders.columns, col("boom")] };
    const after: TableSpec = { name: "notes", columns: [col("text", { udt: "text" })] };
    const counts = new Map([
      ["customers", 1],
      ["orders", 1],
      ["notes", 2],
    ]);
    const run = startSeedRun({
      connection,
      runner,
      schema: "public",
      tables: [after, boom, customers],
      counts,
      truncate: true,
      actor: "root",
    });
    await settle();
    const done = getSeedRun(run.id)!;
    // The tables in the order they are filled: those with no parent first, as the plan orders them.
    expect(calls[0].sql).toBe(
      'TRUNCATE "public"."notes", "public"."customers", "public"."orders" RESTART IDENTITY CASCADE',
    );
    expect(done.status).toBe("failed");
    expect(done.tables.find((t) => t.name === "orders")).toMatchObject({ inserted: 0, error: "duplicate key" });
    expect(done.tables.find((t) => t.name === "notes")).toMatchObject({ inserted: 2 });
    expect(auditedAt(1)).toMatchObject({
      action: "failed",
      result: "failure",
      reason: "execution_failed",
      rows: 3,
    });
    expect(getSeedRun("ghost")).toBeNull();
  });

  test("a required reference with nothing to point at fails that table; a table with only engine-filled columns is filled through generate_series; one job per datasource", async () => {
    const empty = new Map([
      ["customers", 0],
      ["orders", 2],
    ]);
    const run = startSeedRun({
      connection,
      runner,
      schema: "public",
      tables: [customers, orders],
      counts: empty,
      truncate: false,
      actor: "root",
    });
    expect(() =>
      startSeedRun({
        connection,
        runner,
        schema: "public",
        tables: [customers],
        counts: empty,
        truncate: false,
        actor: "root",
      }),
    ).toThrow("already running");
    await settle();
    expect(getSeedRun(run.id)!.tables[1].error).toContain('"orders.customer_id" needs a row in "customers"');
    const bare: TableSpec = {
      name: "ticks",
      columns: [col("id", { identity: true, hasDefault: true, engineFilled: true, primaryKey: true, unique: true })],
    };
    startSeedRun({
      connection,
      runner,
      schema: "s",
      tables: [bare],
      counts: new Map([["ticks", 4]]),
      truncate: false,
      actor: "root",
    });
    await settle();
    expect(calls.at(-1)?.sql).toBe('INSERT INTO "s"."ticks" SELECT FROM generate_series(1, 4)');
    // A failure before any table (the TRUNCATE) marks every table.
    runner.query.mockImplementationOnce(async () => {
      throw new Error("permission denied");
    });
    const failed = startSeedRun({
      connection,
      runner,
      schema: "s",
      tables: [bare],
      counts: new Map([["ticks", 1]]),
      truncate: true,
      actor: "root",
    });
    await settle();
    expect(getSeedRun(failed.id)!.tables[0].error).toBe("The run stopped before this table");
  });
});
