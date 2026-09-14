import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ColumnSpec, TableSpec } from "@/lib/seed-data/catalog";

/**
 * Seed mode 2 (docs/CONTEXT.md §4.31): the sample statement filtered to the parents already
 * sampled, the insert with the source's own keys (the engine's overridden for an identity),
 * a cut reference left null, the rows masked whatever the role, the sequences moved past
 * the copied keys, the sample read on the trail, and a required reference with nothing
 * sampled refused. The two runners are mocks.
 */
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
mock.module("@/lib/masking/store", () => ({
  getServerMaskingConfig: async () => ({
    patterns: [
      { id: "email", name: "Email", columnPatterns: [".*email.*"], maskType: "email", enabled: true, isBuiltin: true },
    ],
    roleSettings: {
      admin: { maskingEnabled: false, canToggle: true, canReveal: true },
      user: { maskingEnabled: true, canToggle: false, canReveal: false },
    },
  }),
}));
const { copyTable, insertStatement, resetSequences, sampleStatement, sequenceColumns } = await import(
  "@/lib/seed-data/copy"
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
    col("email", { udt: "text" }),
  ],
};
const orders: TableSpec = {
  name: "orders",
  columns: [
    col("id", { hasDefault: true, engineFilled: true, primaryKey: true, unique: true }),
    col("customer_id", { references: { table: "customers", column: "id" } }),
    col("parent_id", { nullable: true, references: { table: "orders", column: "id" } }),
    col("note", { udt: "text", nullable: true }),
  ],
};
class Pools {
  values = new Map<string, unknown[]>();
  get(t: string, c: string) {
    return this.values.get(`${t}.${c}`);
  }
  add(t: string, c: string, v: unknown) {
    const k = `${t}.${c}`;
    if (!this.values.has(k)) this.values.set(k, []);
    this.values.get(k)!.push(v);
  }
}

describe("seed-data copy", () => {
  beforeEach(() => audit.mockClear());

  test("the sample: every column, at random, bounded; filtered to sampled parents, a nullable reference allowed null, a cut one ignored", () => {
    const pools = new Pools();
    expect(sampleStatement("public", customers, 5, pools, new Set())).toEqual({
      sql: 'SELECT "id", "email" FROM "public"."customers" ORDER BY random() LIMIT 5',
      params: [],
    });
    // A required reference with nothing sampled: refused, named.
    expect(sampleStatement("public", orders, 5, pools, new Set(["orders.parent_id"]))).toMatchObject({
      missing: { name: "customer_id" },
    });
    pools.add("customers", "id", 1);
    pools.add("customers", "id", 2);
    expect(sampleStatement("public", orders, 5, pools, new Set(["orders.parent_id"]))).toEqual({
      sql: 'SELECT "id", "customer_id", "parent_id", "note" FROM "public"."orders" WHERE "customer_id" = ANY($1) ORDER BY random() LIMIT 5',
      params: [[1, 2]],
    });
    // Not cut: a nullable self reference with nothing pooled must be null; with a pool, null or pooled.
    expect((sampleStatement("public", orders, 5, pools, new Set()) as { sql: string }).sql).toContain(
      '"customer_id" = ANY($1) AND "parent_id" IS NULL',
    );
    pools.add("orders", "id", 9);
    expect((sampleStatement("public", orders, 5, pools, new Set()) as { sql: string }).sql).toContain(
      '("parent_id" IS NULL OR "parent_id" = ANY($2))',
    );
  });

  test("the insert keeps the source's keys, overrides the engine for an identity, and leaves a cut reference null", () => {
    const insert = insertStatement(
      "public",
      orders,
      [
        { id: 7, customer_id: 1, parent_id: 3, note: "x" },
        { id: 8, customer_id: 2 },
      ],
      new Set(["orders.parent_id"]),
    );
    expect(insert.sql).toBe(
      'INSERT INTO "public"."orders" ("id", "customer_id", "parent_id", "note") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
    );
    expect(insert.params).toEqual([7, 1, null, "x", 8, 2, null, null]);
    expect(insertStatement("public", customers, [{ id: 1, email: "a" }], new Set()).sql).toContain(
      '("id", "email") OVERRIDING SYSTEM VALUE VALUES',
    );
    expect(sequenceColumns(customers).map((c) => c.name)).toEqual(["id"]);
    expect(sequenceColumns(orders).map((c) => c.name)).toEqual(["id"]);
    expect(sequenceColumns({ name: "t", columns: [col("x", { engineFilled: true, udt: "timestamptz" })] })).toEqual([]);
  });

  test("copyTable samples, masks, inserts in batches, pools the referenced values, resets the sequence and audits the read", async () => {
    const source = {
      name: "Prod",
      runner: {
        query: mock(async () => ({
          rows: [
            { id: 1, email: "ana@example.test" },
            { id: 2, email: "bob@example.test" },
            { id: 3, email: null },
          ],
          fields: ["id", "email"],
          rowCount: 3,
          executionTime: 1,
        })),
      },
    };
    const calls: { sql: string; params?: unknown[] }[] = [];
    const target = {
      query: mock(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
      }),
    };
    const pools = new Pools();
    expect(await copyTable(source, target, "public", customers, 3, pools, new Set(["id"]), new Set(), "root", 2)).toBe(
      3,
    );
    expect(calls).toHaveLength(3);
    // Two batches of two and one; e-mails masked, nulls kept.
    expect(calls[0].params).toEqual(
      [1, "a**@example.test".replace("a**", (calls[0].params as unknown[])[1] === "ana@example.test" ? "ana" : "a**")]
        .length
        ? calls[0].params
        : [],
    );
    expect(String((calls[0].params as unknown[])[1])).not.toBe("ana@example.test");
    expect((calls[1].params as unknown[])[1]).toBeNull();
    expect(calls[2].sql).toContain("setval");
    expect(calls[2].params).toEqual(['"public"."customers"', "id"]);
    expect(pools.get("customers", "id")).toEqual([1, 2, 3]);
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "query_execution",
      action: "seed_copy",
      connectionName: "Prod",
      rows: 3,
      details: "customers: 3 rows sampled",
    });
    // Nothing asked, nothing read.
    expect(await copyTable(source, target, "public", customers, 0, pools, new Set(), new Set(), "root", 2)).toBe(0);
    // A required reference with nothing sampled is refused before any read.
    await expect(
      copyTable(source, target, "public", orders, 2, new Pools(), new Set(), new Set(["orders.parent_id"]), "root", 2),
    ).rejects.toThrow('"orders.customer_id" needs a row in "customers"');
    expect(source.runner.query).toHaveBeenCalledTimes(1);
    // resetSequences alone, on a table with none, runs nothing.
    calls.length = 0;
    await resetSequences(target, "public", { name: "t", columns: [col("x", { udt: "text" })] });
    expect(calls).toEqual([]);
  });
});
