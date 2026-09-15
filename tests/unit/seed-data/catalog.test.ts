import { describe, test, expect, mock } from "bun:test";
import { readCatalog, readSchemaName } from "@/lib/seed-data/catalog";

/**
 * The catalog reader (docs/CONTEXT.md §4.23): four catalog queries, each bound to the schema
 * name, folded into one spec per table - the engine's types, what it fills itself, the
 * single-column keys, the foreign keys, the enum labels. A schema with no tables is a 404;
 * a schema name that is not an identifier is refused before any query.
 */
const rows = {
  columns: [
    {
      table_name: "customers",
      column_name: "id",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
      column_default: null,
      is_identity: "YES",
      character_maximum_length: null,
      numeric_precision: 32,
      numeric_scale: 0,
    },
    {
      table_name: "customers",
      column_name: "email",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "NO",
      column_default: null,
      is_identity: "NO",
      character_maximum_length: 120,
      numeric_precision: null,
      numeric_scale: null,
    },
    {
      table_name: "orders",
      column_name: "id",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
      column_default: "nextval('orders_id_seq'::regclass)",
      is_identity: "NO",
      character_maximum_length: null,
      numeric_precision: 32,
      numeric_scale: 0,
    },
    {
      table_name: "orders",
      column_name: "customer_id",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
      column_default: null,
      is_identity: "NO",
      character_maximum_length: null,
      numeric_precision: 32,
      numeric_scale: 0,
    },
    {
      table_name: "orders",
      column_name: "status",
      data_type: "USER-DEFINED",
      udt_name: "order_status",
      is_nullable: "NO",
      column_default: "'open'::order_status",
      is_identity: "NO",
      character_maximum_length: null,
      numeric_precision: null,
      numeric_scale: null,
    },
    {
      table_name: "orders",
      column_name: "created_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "NO",
      column_default: "now()",
      is_identity: "NO",
      character_maximum_length: null,
      numeric_precision: null,
      numeric_scale: null,
    },
  ],
  keys: [
    {
      table_name: "customers",
      constraint_type: "PRIMARY KEY",
      column_name: "id",
      constraint_name: "customers_pkey",
      width: 1,
    },
    {
      table_name: "customers",
      constraint_type: "UNIQUE",
      column_name: "email",
      constraint_name: "customers_email_key",
      width: 1,
    },
    {
      table_name: "orders",
      constraint_type: "PRIMARY KEY",
      column_name: "id",
      constraint_name: "orders_pkey",
      width: 1,
    },
    {
      table_name: "orders",
      constraint_type: "UNIQUE",
      column_name: "customer_id",
      constraint_name: "orders_pair",
      width: 2,
    },
  ],
  fks: [{ table_name: "orders", column_name: "customer_id", ref_table: "customers", ref_column: "id" }],
  enums: [
    { name: "order_status", label: "open" },
    { name: "order_status", label: "closed" },
  ],
};
const runner = {
  query: mock(async (sql: string) => {
    const set = sql.includes("information_schema.columns")
      ? rows.columns
      : sql.includes("pg_enum")
        ? rows.enums
        : sql.includes("FOREIGN KEY")
          ? rows.fks
          : rows.keys;
    return { rows: set, fields: [], rowCount: set.length, executionTime: 1 };
  }),
};

describe("seed-data catalog", () => {
  test("folds the four reads into one spec per table, every read bound to the schema", async () => {
    // The portal's own store tables are never part of a plan, whatever schema they sit in.
    rows.columns.push({ ...rows.columns[0], table_name: "user_storage", column_name: "owner_id" });
    rows.columns.push({ ...rows.columns[0], table_name: "jobs", column_name: "kind" });
    rows.columns.push({ ...rows.columns[0], table_name: "leases", column_name: "holder" });
    rows.columns.push({ ...rows.columns[0], table_name: "audit_events_p2026_09", column_name: "ts" });
    const tables = await readCatalog(runner, "public");
    rows.columns.pop();
    rows.columns.pop();
    rows.columns.pop();
    rows.columns.pop();
    for (const call of runner.query.mock.calls) expect((call as unknown[])[1]).toEqual(["public"]);
    expect(tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    const [customers, orders] = tables;
    expect(customers.columns[0]).toMatchObject({
      name: "id",
      udt: "int4",
      identity: true,
      hasDefault: true,
      primaryKey: true,
      unique: true,
    });
    expect(customers.columns[1]).toMatchObject({
      name: "email",
      maxLength: 120,
      unique: true,
      primaryKey: false,
      nullable: false,
    });
    expect(orders.columns[0]).toMatchObject({ name: "id", identity: true, hasDefault: true });
    // A two-column unique key is not a per-column uniqueness.
    expect(orders.columns[1]).toMatchObject({
      name: "customer_id",
      unique: false,
      references: { table: "customers", column: "id" },
    });
    // A constant default is still generated; a call default is the engine's.
    expect(orders.columns[2]).toMatchObject({
      name: "status",
      enumLabels: ["open", "closed"],
      hasDefault: true,
      identity: false,
      engineFilled: false,
    });
    expect(orders.columns[3]).toMatchObject({
      name: "created_at",
      hasDefault: true,
      engineFilled: true,
      identity: false,
    });
    expect(orders.columns[0]).toMatchObject({ engineFilled: true });
  });

  test("a schema without tables is a 404, and a schema name that is not an identifier is refused", async () => {
    const empty = { query: mock(async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 0 })) };
    const err = await readCatalog(empty, "nothing").catch((e) => e);
    expect(err.statusCode).toBe(404);
    expect(readSchemaName(undefined)).toBe("public");
    expect(readSchemaName("")).toBe("public");
    expect(readSchemaName("sales_2026")).toBe("sales_2026");
    expect(() => readSchemaName("public; DROP")).toThrow("identifier");
    expect(() => readSchemaName(42)).toThrow("identifier");
  });
});
