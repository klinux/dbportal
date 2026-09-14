import { describe, test, expect } from "bun:test";
import type { ColumnSpec, TableSpec } from "@/lib/seed-data/catalog";
import { buildPlan, orderTables, readCounts, DEFAULT_ROWS, MAX_ROWS_PER_TABLE } from "@/lib/seed-data/plan";

/**
 * The plan (docs/CONTEXT.md §4.23): parents before children, a reference to the table itself
 * left null, a nullable reference cut to break a cycle, a cycle of required references
 * refused with the tables named; and the counts a caller sends, bounded.
 */
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
const table = (name: string, columns: ColumnSpec[]): TableSpec => ({ name, columns });

describe("seed-data plan", () => {
  test("orders parents before children and names what each depends on", () => {
    const tables = [
      table("order_items", [
        col("order_id", { references: { table: "orders", column: "id" } }),
        col("product_id", { references: { table: "products", column: "id" } }),
      ]),
      table("orders", [col("customer_id", { references: { table: "customers", column: "id" } })]),
      table("products", [col("id")]),
      table("customers", [col("id")]),
    ];
    const plan = buildPlan(tables);
    expect(plan.map((t) => t.name)).toEqual(["products", "customers", "orders", "order_items"]);
    expect(plan.find((t) => t.name === "order_items")?.dependsOn).toEqual(["orders", "products"]);
    expect(plan.every((t) => t.rows === DEFAULT_ROWS)).toBe(true);
    expect(buildPlan(tables, 7)[0].rows).toBe(7);
  });

  test("a reference to the table itself and a nullable reference in a cycle are left null; a required cycle is refused", () => {
    const selfRef = [
      table("employees", [col("manager_id", { nullable: true, references: { table: "employees", column: "id" } })]),
    ];
    expect(orderTables(selfRef).softened.has("employees.manager_id")).toBe(true);
    const nullableCycle = [
      table("a", [col("b_id", { nullable: true, references: { table: "b", column: "id" } })]),
      table("b", [col("a_id", { references: { table: "a", column: "id" } })]),
    ];
    const ordered = orderTables(nullableCycle);
    expect(ordered.order.map((t) => t.name)).toEqual(["a", "b"]);
    expect(ordered.softened.has("a.b_id")).toBe(true);
    const requiredCycle = [
      table("a", [col("b_id", { references: { table: "b", column: "id" } })]),
      table("b", [col("a_id", { references: { table: "a", column: "id" } })]),
    ];
    expect(() => orderTables(requiredCycle)).toThrow("cannot be ordered: a, b");
    // A reference to a table outside the schema is not a dependency.
    const outside = [table("x", [col("y_id", { references: { table: "elsewhere", column: "id" } })])];
    expect(buildPlan(outside)[0].dependsOn).toEqual([]);
  });

  test("readCounts keeps the plan's default where nothing is given, bounds what is, and refuses the rest", () => {
    const plan = buildPlan([table("a", [col("id")]), table("b", [col("id")])]);
    expect([...readCounts(undefined, plan).values()]).toEqual([DEFAULT_ROWS, DEFAULT_ROWS]);
    expect([...readCounts({ a: 0, b: "25" }, plan).entries()]).toEqual([
      ["a", 0],
      ["b", 25],
    ]);
    expect(() => readCounts({ a: -1 }, plan)).toThrow('rows for "a"');
    expect(() => readCounts({ a: 1.5 }, plan)).toThrow('rows for "a"');
    expect(() => readCounts({ a: MAX_ROWS_PER_TABLE + 1 }, plan)).toThrow('rows for "a"');
    expect([...readCounts([1, 2], plan).values()]).toEqual([DEFAULT_ROWS, DEFAULT_ROWS]);
  });
});
