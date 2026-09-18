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
const copyTable = mock(
  async (
    _s: unknown,
    _t: unknown,
    _schema: string,
    table: { name: string },
    count: number,
    pools: { add(t: string, c: string, v: unknown): void },
  ) => {
    for (let i = 1; i <= count; i++) pools.add(table.name, "id", i);
    return count;
  },
);
mock.module("@/lib/seed-data/copy", () => ({ copyTable }));

const { MAX_BATCH_ROWS, assertSeedable, getSeedRun, resetSeedRuns, runSeedNow, seedAllowed, startSeedRun } =
  await import("@/lib/seed-data/run");

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
    if (sql.startsWith("TRUNCATE") || sql.startsWith("DELETE") || sql.startsWith("ALTER"))
      return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
    // MySQL: the batch's keys are read back as the last rows by the numbered column.
    const readBack = sql.match(/^SELECT `id` AS `id` FROM .* LIMIT (\d+)$/);
    if (readBack) {
      const n = Number(readBack[1]);
      return {
        rows: Array.from({ length: n }, (_v, i) => ({ id: nextId - i })),
        fields: ["id"],
        rowCount: n,
        executionTime: 1,
      };
    }
    if (sql.startsWith("INSERT INTO `")) {
      const n = (sql.match(/\(/g) ?? []).length - 1;
      nextId += n;
      return { rows: [], fields: [], rowCount: n, executionTime: 1 };
    }
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

  test("the guard: PostgreSQL or MySQL, never production, never inside a freeze window", async () => {
    expect(seedAllowed({ type: "mongodb", environment: "staging" })).toContain("PostgreSQL and MySQL");
    expect(seedAllowed({ type: "postgres", environment: "production" })).toContain("production");
    expect(seedAllowed({ type: "mysql", environment: "production" })).toContain("production");
    expect(seedAllowed({ type: "postgres", environment: "staging" })).toBeNull();
    expect(seedAllowed({ type: "mysql", environment: "staging" })).toBeNull();
    await expect(assertSeedable(connection)).resolves.toBeUndefined();
    frozen = { reason: "Release", until: "2026-09-15T00:00:00.000Z" };
    const err = await assertSeedable(connection).catch((e) => e);
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain("frozen");
  });

  // docs/CONTEXT.md §4.23 on MySQL: the same run with MySQL's statements - `?` binds, the
  // keys read back after each batch, the tables emptied with DELETE children first.
  test("fills a MySQL datasource with its own statements, reading the numbered keys back", async () => {
    const run = await runSeedNow({
      connection: { ...(connection as object), type: "mysql", database: "shop" } as never,
      runner,
      schema: "shop",
      tables: [orders, customers],
      counts: new Map([
        ["customers", 3],
        ["orders", 2],
      ]),
      truncate: true,
      actor: "root",
    });

    expect(run.status).toBe("done");
    expect(run.tables).toEqual([
      { name: "customers", target: 3, inserted: 3 },
      { name: "orders", target: 2, inserted: 2 },
    ]);
    expect(calls.map((c) => c.sql).slice(0, 4)).toEqual([
      "DELETE FROM `public`.`orders`".replace("public", "shop"),
      "DELETE FROM `shop`.`customers`",
      "ALTER TABLE `shop`.`customers` AUTO_INCREMENT = 1",
      "ALTER TABLE `shop`.`orders` AUTO_INCREMENT = 1",
    ]);
    expect(calls[4].sql).toBe("INSERT INTO `shop`.`customers` (`email`) VALUES (?), (?), (?)");
    expect(calls[4].params).toHaveLength(3);
    expect(calls[5].sql).toBe("SELECT `id` AS `id` FROM `shop`.`customers` ORDER BY `id` DESC LIMIT 3");
    expect(calls[6].sql).toBe("INSERT INTO `shop`.`orders` (`customer_id`, `status`) VALUES (?, ?), (?, ?)");
    for (const v of calls[6].params!.filter((_v, i) => i % 2 === 0)) expect([1, 2, 3]).toContain(v as number);
    // Nothing points at orders: no read-back for it.
    expect(calls).toHaveLength(7);
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

  // docs/CONTEXT.md §4.31: the copy mode hands each table to the copier with the source; a ratio takes the parent's rows times it.
  test("copy mode copies each table from the source in order; a ratio sizes a child by the parent's rows, in either mode", async () => {
    copyTable.mockClear();
    const source = { name: "Prod", runner };
    const run = startSeedRun({
      connection,
      runner,
      schema: "public",
      tables: [orders, customers],
      counts: new Map([
        ["customers", 3],
        ["orders", 99],
      ]),
      ratios: new Map([["orders", 4]]),
      mode: "copy",
      source,
      truncate: false,
      actor: "root",
    });
    expect(run.mode).toBe("copy");
    expect(run.sourceName).toBe("Prod");
    expect(auditedAt(0)).toMatchObject({ details: "copied from Prod, 2 tables, 102 rows, 1 by ratio" });
    await settle();
    const done = getSeedRun(run.id)!;
    expect(done.status).toBe("done");
    expect(done.tables).toEqual([
      { name: "customers", target: 3, inserted: 3 },
      { name: "orders", target: 12, inserted: 12 },
    ]);
    expect(copyTable.mock.calls[0][0]).toBe(source);
    expect((copyTable.mock.calls[1][3] as { name: string }).name).toBe("orders");
    expect(copyTable.mock.calls[1][4]).toBe(12);
    // A copier that refuses keeps the failure on its table.
    copyTable.mockImplementationOnce(async () => {
      throw new Error("permission denied for table customers");
    });
    const failed = startSeedRun({
      connection,
      runner,
      schema: "public",
      tables: [customers],
      counts: new Map([["customers", 1]]),
      mode: "copy",
      source,
      truncate: false,
      actor: "root",
    });
    await settle();
    expect(getSeedRun(failed.id)!.tables[0].error).toBe("permission denied for table customers");
    // In generate mode a ratio applies too, from the keys the engine returned.
    calls.length = 0;
    nextId = 0;
    const generated = startSeedRun({
      connection,
      runner,
      schema: "public",
      tables: [customers, orders],
      counts: new Map([
        ["customers", 2],
        ["orders", 0],
      ]),
      ratios: new Map([["orders", 3]]),
      truncate: false,
      actor: "root",
    });
    await settle();
    expect(getSeedRun(generated.id)!.tables[1]).toEqual({ name: "orders", target: 6, inserted: 6 });
  });

  // docs/CONTEXT.md §4.40: a worker runs to the end here, under the id the queue chose, telling its progress table by table.
  test("runSeedNow awaits the run under the caller's id and hands a snapshot after each table; a snapshot that fails to write is a warning", async () => {
    const snapshots: { status: string; inserted: number[] }[] = [];
    let calls = 0;
    const run = await runSeedNow(
      {
        connection,
        runner,
        schema: "public",
        tables: [orders, customers],
        counts: new Map([
          ["customers", 2],
          ["orders", 3],
        ]),
        truncate: false,
        actor: "root",
        runId: "job-42",
      },
      async (snapshot) => {
        calls++;
        if (calls === 1) throw new Error("store hiccup");
        snapshots.push({ status: snapshot.status, inserted: snapshot.tables.map((t) => t.inserted) });
      },
    );
    expect(run.id).toBe("job-42");
    expect(run.status).toBe("done");
    expect(calls).toBe(2);
    expect(snapshots).toEqual([{ status: "running", inserted: [2, 3] }]);
    expect(getSeedRun("job-42")?.status).toBe("done");
  });
});
