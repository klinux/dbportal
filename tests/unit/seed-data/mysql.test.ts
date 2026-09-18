import { describe, expect, test } from "bun:test";
import type { ColumnSpec, TableSpec } from "@/lib/seed-data/catalog";
import { readCatalog, readSchemaName } from "@/lib/seed-data/catalog";
import { seedEngineLabel, seedEngineOf } from "@/lib/seed-data/engine";
import { SeedDataError } from "@/lib/seed-data/errors";
import {
  MYSQL_COLUMNS_SQL,
  MYSQL_FKS_SQL,
  MYSQL_KEYS_SQL,
  MYSQL_MAX_IN,
  boundedPool,
  enumLabelsOf,
  mysqlEmptyStatements,
  mysqlInsert,
  mysqlInsertCopied,
  mysqlReadBack,
  mysqlSample,
  mysqlUdt,
  mysqlWrittenColumns,
  readMysqlCatalog,
  readMysqlSchemaName,
} from "@/lib/seed-data/mysql";

/**
 * The MySQL side of the seed (docs/CONTEXT.md §4.23): the catalog read from
 * information_schema into the spec the plan and generators take, MySQL's types mapped
 * onto the generators' vocabulary, and the statements MySQL spells differently - no
 * RETURNING (a read-back of the last rows), no TRUNCATE CASCADE (DELETE children first),
 * `?` binds and a bounded IN list, generated columns never written.
 */
type Rows = Record<string, unknown>[];
const column = (over: Record<string, unknown>) => ({
  table_name: "customers",
  column_name: "id",
  data_type: "int",
  column_type: "int",
  is_nullable: "NO",
  column_default: null,
  extra: "",
  character_maximum_length: null,
  numeric_precision: 10,
  numeric_scale: 0,
  ...over,
});
const catalogRows = {
  columns: [
    column({ extra: "auto_increment" }),
    column({
      column_name: "email",
      data_type: "varchar",
      column_type: "varchar(120)",
      character_maximum_length: 120,
      numeric_precision: null,
      numeric_scale: null,
    }),
    column({
      column_name: "active",
      data_type: "tinyint",
      column_type: "tinyint(1)",
      column_default: "1",
      numeric_precision: 3,
    }),
    column({ column_name: "kind", data_type: "enum", column_type: "enum('a','b''c')", column_default: "a" }),
    column({
      column_name: "created_at",
      data_type: "timestamp",
      column_type: "timestamp",
      column_default: "CURRENT_TIMESTAMP",
      extra: "DEFAULT_GENERATED",
    }),
    column({
      column_name: "token",
      data_type: "char",
      column_type: "char(36)",
      column_default: "uuid()",
      extra: "DEFAULT_GENERATED",
      character_maximum_length: 36,
    }),
    column({
      column_name: "email_domain",
      data_type: "varchar",
      column_type: "varchar(120)",
      extra: "VIRTUAL GENERATED",
      is_nullable: "YES",
      character_maximum_length: 120,
    }),
    column({ table_name: "orders", extra: "auto_increment" }),
    column({ table_name: "orders", column_name: "customer_id" }),
    column({
      table_name: "orders",
      column_name: "total",
      data_type: "decimal",
      column_type: "decimal(10,2)",
      numeric_scale: 2,
    }),
    column({ table_name: "audit_events", column_name: "id", extra: "auto_increment" }),
  ] as Rows,
  keys: [
    { table_name: "customers", constraint_type: "PRIMARY KEY", column_name: "id", width: 1 },
    { table_name: "customers", constraint_type: "UNIQUE", column_name: "email", width: "1" },
    { table_name: "orders", constraint_type: "PRIMARY KEY", column_name: "id", width: 1 },
    { table_name: "orders", constraint_type: "UNIQUE", column_name: "customer_id", width: 2 },
  ] as Rows,
  fks: [{ table_name: "orders", column_name: "customer_id", ref_table: "customers", ref_column: "id" }] as Rows,
};
function runner(rows = catalogRows) {
  const asked: [string, unknown[] | undefined][] = [];
  return {
    asked,
    query: async (sql: string, params?: unknown[]) => {
      asked.push([sql, params]);
      const answer =
        sql === MYSQL_COLUMNS_SQL
          ? rows.columns
          : sql === MYSQL_KEYS_SQL
            ? rows.keys
            : sql === MYSQL_FKS_SQL
              ? rows.fks
              : [];
      return { rows: answer, fields: [], rowCount: answer.length, executionTime: 1 };
    },
  };
}
const spec = (name: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  dataType: "int",
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
    spec("id", { identity: true, hasDefault: true, engineFilled: true, primaryKey: true, unique: true }),
    spec("email", { udt: "varchar", unique: true }),
    spec("token", { udt: "varchar", hasDefault: true, engineFilled: true }),
    spec("domain", { udt: "varchar", nullable: true, hasDefault: true, engineFilled: true, generated: true }),
  ],
};
const orders: TableSpec = {
  name: "orders",
  columns: [
    spec("id", { identity: true, hasDefault: true, engineFilled: true, primaryKey: true, unique: true }),
    spec("customer_id", { references: { table: "customers", column: "id" } }),
    spec("parent_id", { nullable: true, references: { table: "orders", column: "id" } }),
  ],
};

describe("the MySQL catalog", () => {
  test("reads columns, keys and foreign keys bound to the database, maps the types, and leaves the portal's tables out", async () => {
    const run = runner();
    const tables = await readMysqlCatalog(run, "shop");

    expect(run.asked.map(([, params]) => params)).toEqual([["shop"], ["shop"], ["shop", "shop"]]);
    expect(tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    const byName = Object.fromEntries(tables[0].columns.map((c) => [c.name, c]));
    expect(byName.id).toMatchObject({
      udt: "int4",
      identity: true,
      engineFilled: true,
      hasDefault: true,
      primaryKey: true,
      unique: true,
    });
    expect(byName.email).toMatchObject({
      udt: "varchar",
      maxLength: 120,
      unique: true,
      primaryKey: false,
      hasDefault: false,
    });
    // tinyint(1) is the boolean; a constant default is still generated.
    expect(byName.active).toMatchObject({ udt: "bool", engineFilled: false, hasDefault: true });
    expect(byName.kind).toMatchObject({ udt: "enum", enumLabels: ["a", "b'c"] });
    // A stamped timestamp and an expression default are the engine's; a generated column is marked so.
    expect(byName.created_at).toMatchObject({ udt: "datetime", engineFilled: true });
    expect(byName.token).toMatchObject({ engineFilled: true, identity: false });
    expect(byName.email_domain).toMatchObject({ generated: true, engineFilled: true, nullable: true });
    expect(byName.email_domain.generated).toBe(true);
    const order = Object.fromEntries(tables[1].columns.map((c) => [c.name, c]));
    expect(order.customer_id).toMatchObject({ references: { table: "customers", column: "id" }, unique: false });
    expect(order.total).toMatchObject({ udt: "numeric", numericScale: 2 });
  });

  test("refuses a database with no tables, and reaches the MySQL read through the shared entry", async () => {
    const empty = runner({ columns: [], keys: [], fks: [] });
    const err = await readMysqlCatalog(empty, "void").catch((e) => e);
    expect(err).toBeInstanceOf(SeedDataError);
    expect(err.statusCode).toBe(404);
    expect((await readCatalog(runner(), "shop", "mysql")).map((t) => t.name)).toEqual(["customers", "orders"]);
  });

  test("the schema is the datasource's database unless the request names one, and must be a database name", () => {
    expect(readMysqlSchemaName(undefined, "shop")).toBe("shop");
    expect(readMysqlSchemaName("", "shop")).toBe("shop");
    expect(readMysqlSchemaName("Other-DB_1", "shop")).toBe("Other-DB_1");
    expect(readSchemaName(undefined, "mysql", "shop")).toBe("shop");
    expect(() => readMysqlSchemaName(undefined, undefined)).toThrow(SeedDataError);
    expect(() => readMysqlSchemaName("bad name", "shop")).toThrow(SeedDataError);
    expect(() => readMysqlSchemaName(7, "shop")).toThrow(SeedDataError);
  });

  test("maps every MySQL type onto the generators' vocabulary", () => {
    const cases: [string, string, string][] = [
      ["tinyint", "tinyint(1)", "bool"],
      ["tinyint", "tinyint unsigned", "int1"],
      ["bit", "bit(1)", "bool"],
      ["bit", "bit(8)", "int4"],
      ["smallint", "smallint", "int2"],
      ["mediumint", "mediumint", "int4"],
      ["integer", "integer", "int4"],
      ["bigint", "bigint unsigned", "int8"],
      ["dec", "dec(5,2)", "numeric"],
      ["float", "float", "float4"],
      ["real", "real", "float8"],
      ["date", "date", "date"],
      ["datetime", "datetime(6)", "datetime"],
      ["time", "time", "time"],
      ["year", "year", "year"],
      ["char", "char(2)", "varchar"],
      ["tinytext", "tinytext", "text"],
      ["text", "text", "text"],
      ["longtext", "longtext", "text"],
      ["varbinary", "varbinary(16)", "bytea"],
      ["json", "json", "json"],
      ["set", "set('x','y')", "enum"],
      ["geometry", "geometry", "geometry"],
    ];
    for (const [dataType, columnType, udt] of cases) expect(mysqlUdt(dataType, columnType)).toBe(udt);
    expect(enumLabelsOf("enum('open','it''s')")).toEqual(["open", "it's"]);
    expect(enumLabelsOf("int")).toEqual([]);
  });
});

describe("the MySQL statements", () => {
  test("writes what the engine does not fill, plus a referenced column it would fill, never a generated one", () => {
    const wanted = new Set(["token"]);
    expect(mysqlWrittenColumns(customers, new Set(), wanted).map((c) => c.name)).toEqual(["email", "token"]);
    expect(mysqlWrittenColumns(customers, new Set(), new Set(["id"])).map((c) => c.name)).toEqual(["email"]);
    expect(mysqlWrittenColumns(orders, new Set(["orders.parent_id"]), new Set()).map((c) => c.name)).toEqual([
      "customer_id",
    ]);
  });

  test("the insert binds every value with ?, or inserts empty rows when nothing is written", () => {
    const columns = customers.columns.filter((c) => c.name === "email");
    expect(mysqlInsert("shop", customers, columns, [["a@x"], ["b@x"]])).toEqual({
      sql: "INSERT INTO `shop`.`customers` (`email`) VALUES (?), (?)",
      params: ["a@x", "b@x"],
    });
    expect(mysqlInsert("shop", customers, [], [[], [], []])).toEqual({
      sql: "INSERT INTO `shop`.`customers` () VALUES (), (), ()",
      params: [],
    });
  });

  test("reads the batch's keys back as the last rows by the numbered column, and empties children first", () => {
    expect(mysqlReadBack("shop", customers, "id", 3)).toBe(
      "SELECT `id` AS `id` FROM `shop`.`customers` ORDER BY `id` DESC LIMIT 3",
    );
    expect(mysqlEmptyStatements("shop", [customers, orders])).toEqual([
      "DELETE FROM `shop`.`orders`",
      "DELETE FROM `shop`.`customers`",
      "ALTER TABLE `shop`.`customers` AUTO_INCREMENT = 1",
      "ALTER TABLE `shop`.`orders` AUTO_INCREMENT = 1",
    ]);
  });

  test("the sample lists the sampled parents in a bounded IN, allows null on a nullable reference, and refuses a required one with no parent", () => {
    const pools = { get: (t: string, c: string) => (t === "customers" && c === "id" ? [1, 2, 3] : undefined) };
    expect(mysqlSample("shop", customers, 5, pools, new Set())).toEqual({
      sql: "SELECT `id`, `email`, `token` FROM `shop`.`customers` ORDER BY RAND() LIMIT 5",
      params: [],
    });
    expect(mysqlSample("shop", orders, 5, pools, new Set(["orders.parent_id"]))).toEqual({
      sql: "SELECT `id`, `customer_id`, `parent_id` FROM `shop`.`orders` WHERE `customer_id` IN (?, ?, ?) ORDER BY RAND() LIMIT 5",
      params: [1, 2, 3],
    });
    const both = { get: (t: string) => (t === "customers" ? [1, 2, 3] : [9]) };
    const withParent = mysqlSample("shop", orders, 5, both, new Set()) as { sql: string; params: unknown[] };
    expect(withParent.sql).toContain("(`parent_id` IS NULL OR `parent_id` IN (?))");
    expect(withParent.params).toEqual([1, 2, 3, 9]);
    const nothing = mysqlSample("shop", orders, 5, { get: () => undefined }, new Set());
    expect("missing" in nothing && nothing.missing.name).toBe("customer_id");
    const orphan = mysqlSample("shop", orders, 5, { get: (t) => (t === "customers" ? [1] : undefined) }, new Set());
    expect("sql" in orphan && orphan.sql).toContain("AND `parent_id` IS NULL ORDER");
    const big = boundedPool(Array.from({ length: MYSQL_MAX_IN + 50 }, (_, i) => i));
    expect(big).toHaveLength(MYSQL_MAX_IN);
    expect(new Set(big).size).toBe(MYSQL_MAX_IN);
  });

  test("the copied insert carries the source's keys, a cut reference as null, and no generated column", () => {
    expect(
      mysqlInsertCopied(
        "shop",
        orders,
        [
          { id: 7, customer_id: 1, parent_id: 5 },
          { id: 8, customer_id: 2, parent_id: null },
        ],
        new Set(["orders.parent_id"]),
      ),
    ).toEqual({
      sql: "INSERT INTO `shop`.`orders` (`id`, `customer_id`, `parent_id`) VALUES (?, ?, ?), (?, ?, ?)",
      params: [7, 1, null, 8, 2, null],
    });
    expect(mysqlInsertCopied("shop", customers, [{ id: 1, email: "a", token: "t", domain: "x" }], new Set()).sql).toBe(
      "INSERT INTO `shop`.`customers` (`id`, `email`, `token`) VALUES (?, ?, ?)",
    );
  });

  test("the engines a seed knows", () => {
    expect(seedEngineOf("postgres")).toBe("postgres");
    expect(seedEngineOf("mysql")).toBe("mysql");
    expect(seedEngineOf("mongodb")).toBeNull();
    expect(seedEngineOf(undefined)).toBeNull();
    expect(seedEngineLabel("mysql")).toBe("MySQL");
    expect(seedEngineLabel("postgres")).toBe("PostgreSQL");
  });
});
