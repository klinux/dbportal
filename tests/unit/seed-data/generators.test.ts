import { describe, test, expect } from "bun:test";
import type { ColumnSpec } from "@/lib/seed-data/catalog";
import { valueFor } from "@/lib/seed-data/generators";

/**
 * The values (docs/CONTEXT.md §4.23): typed as the column is, unique where the column is,
 * drawn from the parent's pool for a foreign key, from the labels for an enum, cut to the
 * column's length, null now and then where null is allowed and never where it is not.
 */
const col = (over: Partial<ColumnSpec>): ColumnSpec => ({
  name: "value",
  dataType: "text",
  udt: "text",
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
const pools = { get: (t: string, c: string) => (t === "customers" && c === "id" ? [11, 12, 13] : undefined) };
const many = (column: ColumnSpec, n = 50) => Array.from({ length: n }, (_, i) => valueFor(column, i + 1, pools));

describe("seed-data generators", () => {
  test("numbers, booleans, dates, uuids, json and arrays come typed as the engine types them", () => {
    for (const v of many(col({ udt: "int4" }))) expect(Number.isInteger(v) && (v as number) > 0).toBe(true);
    for (const v of many(col({ udt: "int2" }))) expect((v as number) <= 32_767).toBe(true);
    for (const v of many(col({ udt: "numeric", numericScale: 2 }))) expect(typeof v).toBe("number");
    for (const v of many(col({ udt: "bool" }))) expect(typeof v).toBe("boolean");
    for (const v of many(col({ udt: "date" }))) expect(String(v)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const v of many(col({ udt: "timestamptz" }))) expect(Number.isNaN(Date.parse(String(v)))).toBe(false);
    for (const v of many(col({ udt: "time" }))) expect(String(v)).toMatch(/^\d{2}:\d{2}:00$/);
    for (const v of many(col({ udt: "uuid" }))) expect(String(v)).toMatch(/^[0-9a-f-]{36}$/);
    for (const v of many(col({ udt: "jsonb" }))) expect(() => JSON.parse(String(v))).not.toThrow();
    expect(valueFor(col({ udt: "_text" }), 1, pools)).toBe("{}");
    expect(valueFor(col({ udt: "interval" }), 1, pools)).toMatch(/days$/);
    expect(valueFor(col({ udt: "inet" }), 1, pools)).toMatch(/^10\.\d+\.\d+\.\d+$/);
    expect(valueFor(col({ udt: "bytea" }), 1, pools)).toEqual(Buffer.from([0]));
    expect(valueFor(col({ udt: "bytea", nullable: true }), 1, pools)).toBeNull();
    // An unknown type is null where allowed and text where not.
    expect(valueFor(col({ udt: "geometry", nullable: true }), 1, pools)).toBeNull();
    expect(typeof valueFor(col({ udt: "geometry" }), 1, pools)).toBe("string");
  });

  test("text follows the column's name, stays inside its length, and a unique column never repeats", () => {
    expect(valueFor(col({ name: "email", udt: "varchar" }), 7, pools)).toBe("user7@example.test");
    expect(valueFor(col({ name: "city", udt: "varchar" }), 3, pools)).toBe("Curitiba");
    expect(String(valueFor(col({ name: "country_code", udt: "bpchar", maxLength: 2 }), 3, pools))).toHaveLength(2);
    expect(String(valueFor(col({ name: "phone", udt: "varchar" }), 3, pools))).toMatch(/^\+55 11 9\d{8}$/);
    expect(String(valueFor(col({ name: "homepage_url", udt: "text" }), 3, pools))).toMatch(
      /^https:\/\/example\.test\//,
    );
    expect(String(valueFor(col({ name: "description", udt: "text" }), 3, pools)).split(" ")).toHaveLength(4);
    expect(String(valueFor(col({ name: "sku", udt: "text" }), 3, pools))).toMatch(/-3$/);
    expect(String(valueFor(col({ name: "note", udt: "varchar", maxLength: 5 }), 3, pools))).toHaveLength(5);
    const emails = many(col({ name: "email", udt: "varchar", unique: true }), 200);
    expect(new Set(emails).size).toBe(200);
    const names = many(col({ name: "name", udt: "text", unique: true }), 200);
    expect(new Set(names).size).toBe(200);
    const ints = many(col({ udt: "int8", unique: true }), 200);
    expect(new Set(ints).size).toBe(200);
    for (const v of many(col({ name: "first_name", udt: "text" }))) expect(typeof v).toBe("string");
  });

  test("a foreign key draws from the parent's pool and is null when the pool is empty; an enum draws from its labels; nulls land only where allowed", () => {
    const fk = col({ name: "customer_id", udt: "int4", references: { table: "customers", column: "id" } });
    for (const v of many(fk)) expect([11, 12, 13]).toContain(v as number);
    expect(valueFor(col({ ...fk, references: { table: "ghost", column: "id" } }), 1, pools)).toBeNull();
    const status = col({
      name: "status",
      udt: "order_status",
      dataType: "user-defined",
      enumLabels: ["open", "closed"],
    });
    for (const v of many(status)) expect(["open", "closed"]).toContain(v as string);
    expect(many(col({ udt: "int4" })).every((v) => v !== null)).toBe(true);
    const nullable = many(col({ udt: "int4", nullable: true }));
    expect(nullable.some((v) => v === null)).toBe(true);
    expect(nullable.filter((v) => v === null).length).toBe(5);
    expect(many(col({ udt: "int4", nullable: true, unique: true })).every((v) => v !== null)).toBe(true);
  });
});
