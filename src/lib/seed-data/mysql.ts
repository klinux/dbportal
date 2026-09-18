import { quoteIdentifier } from "@/lib/sql/identifier";
import type { QueryResult } from "@/lib/db/types";
import type { ColumnSpec, TableSpec } from "./catalog";
import { SeedDataError } from "./errors";
import { isPortalTable } from "./portal-tables";

/**
 * The MySQL side of the seed (docs/CONTEXT.md §4.23): the catalog read from
 * `information_schema` into the same `TableSpec` the plan and the generators take, with
 * MySQL's types mapped onto the type vocabulary the generators already speak, and the
 * statements MySQL spells differently from PostgreSQL.
 *
 * What differs, and why each is here rather than a branch in the shared runner:
 * - No `RETURNING`: the keys the engine hands out (`AUTO_INCREMENT`) are read back after
 *   each batch, the last `n` rows by that column; a value the engine would fill with a
 *   default expression is generated here instead where a foreign key needs it, so it is
 *   known without a read.
 * - No `TRUNCATE ... CASCADE`: with foreign keys on, MySQL refuses to truncate a referenced
 *   table however empty, and `FOREIGN_KEY_CHECKS` is a session variable a pooled runner
 *   cannot pin; the tables are emptied with `DELETE`, children first, and the counter of
 *   an `AUTO_INCREMENT` column is reset with `ALTER TABLE`.
 * - `?` binds and `IN (?, ?, ...)`: the driver's prepared statements take no array for
 *   one placeholder, so a sample filtered to sampled parents lists them, bounded.
 * - A generated column (`VIRTUAL` or `STORED`) can be neither written nor copied.
 */
type Runner = { query(sql: string, params?: unknown[]): Promise<QueryResult> };

export const MYSQL_COLUMNS_SQL = [
  "SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,",
  "c.COLUMN_TYPE AS column_type, c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default,",
  "c.EXTRA AS extra, c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,",
  "c.NUMERIC_PRECISION AS numeric_precision, c.NUMERIC_SCALE AS numeric_scale",
  "FROM information_schema.COLUMNS c",
  "JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME",
  "WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'",
  "ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION",
].join(" ");

/** Single-column keys: MySQL names a constraint per table (`PRIMARY`), so the width counts within the table. */
export const MYSQL_KEYS_SQL = [
  "SELECT tc.TABLE_NAME AS table_name, tc.CONSTRAINT_TYPE AS constraint_type, kcu.COLUMN_NAME AS column_name,",
  "(SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k2",
  " WHERE k2.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k2.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k2.TABLE_NAME = tc.TABLE_NAME) AS width",
  "FROM information_schema.TABLE_CONSTRAINTS tc",
  "JOIN information_schema.KEY_COLUMN_USAGE kcu",
  " ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA AND kcu.TABLE_NAME = tc.TABLE_NAME",
  "WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')",
].join(" ");

/** Foreign keys within the schema; one pointing outside it is left to the engine, the plan cannot fill it. */
export const MYSQL_FKS_SQL = [
  "SELECT kcu.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name,",
  "kcu.REFERENCED_TABLE_NAME AS ref_table, kcu.REFERENCED_COLUMN_NAME AS ref_column",
  "FROM information_schema.KEY_COLUMN_USAGE kcu",
  "WHERE kcu.TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL",
].join(" ");

/** A MySQL database name: what the server accepts, minus the characters a person would not type. */
const SCHEMA_NAME = /^[A-Za-z0-9_$-]{1,64}$/;

/** The database the plan reads: the datasource's own unless the request names another. */
export function readMysqlSchemaName(value: unknown, database: string | undefined): string {
  if (value === undefined || value === null || value === "") {
    if (!database) throw new SeedDataError("schema is required: the datasource names no database", 400);
    return database;
  }
  if (typeof value !== "string" || !SCHEMA_NAME.test(value)) {
    throw new SeedDataError("schema must be a database name", 400);
  }
  return value;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** The labels of an `enum('a','b')` or `set('a','b')` column type, quotes unescaped. */
export function enumLabelsOf(columnType: string): string[] {
  const open = columnType.indexOf("(");
  if (open < 0) return [];
  const labels: string[] = [];
  for (const match of columnType.slice(open + 1).matchAll(/'((?:[^']|'')*)'/g))
    labels.push(match[1].replaceAll("''", "'"));
  return labels;
}

/**
 * MySQL's type as the generators' vocabulary: the same `udt` the PostgreSQL catalog answers
 * where the value's shape is the same, MySQL's own name where it is not (`datetime`, which
 * takes a Date rather than an ISO string; `int1`; `year`).
 */
export function mysqlUdt(dataType: string, columnType: string): string {
  const type = dataType.toLowerCase();
  const spelled = columnType.toLowerCase();
  switch (type) {
    case "tinyint":
      return spelled.startsWith("tinyint(1)") ? "bool" : "int1";
    case "bit":
      return spelled === "bit(1)" ? "bool" : "int4";
    case "smallint":
      return "int2";
    case "mediumint":
    case "int":
    case "integer":
      return "int4";
    case "bigint":
      return "int8";
    case "decimal":
    case "dec":
    case "numeric":
      return "numeric";
    case "float":
      return "float4";
    case "double":
    case "real":
      return "float8";
    case "date":
      return "date";
    case "datetime":
    case "timestamp":
      return "datetime";
    case "time":
      return "time";
    case "year":
      return "year";
    case "char":
    case "varchar":
      return "varchar";
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      return "text";
    case "binary":
    case "varbinary":
    case "tinyblob":
    case "blob":
    case "mediumblob":
    case "longblob":
      return "bytea";
    case "json":
      return "json";
    case "enum":
    case "set":
      return "enum";
    default:
      return type;
  }
}

/** Every table of `schema` with what the seed needs, or a refusal when there is none. */
export async function readMysqlCatalog(runner: Runner, schema: string): Promise<TableSpec[]> {
  const [columns, keys, fks] = await Promise.all([
    runner.query(MYSQL_COLUMNS_SQL, [schema]),
    runner.query(MYSQL_KEYS_SQL, [schema]),
    runner.query(MYSQL_FKS_SQL, [schema, schema]),
  ]);
  const primary = new Set<string>();
  const unique = new Set<string>();
  for (const row of keys.rows) {
    if (Number(row.width) !== 1) continue;
    const key = `${str(row.table_name)}.${str(row.column_name)}`;
    (str(row.constraint_type) === "PRIMARY KEY" ? primary : unique).add(key);
  }
  const references = new Map<string, { table: string; column: string }>();
  for (const row of fks.rows) {
    references.set(`${str(row.table_name)}.${str(row.column_name)}`, {
      table: str(row.ref_table),
      column: str(row.ref_column),
    });
  }
  const tables = new Map<string, TableSpec>();
  for (const row of columns.rows) {
    const table = str(row.table_name);
    if (isPortalTable(table)) continue;
    const name = str(row.column_name);
    const key = `${table}.${name}`;
    const columnType = str(row.column_type);
    const extra = str(row.extra).toLowerCase();
    const columnDefault =
      row.column_default === null || row.column_default === undefined ? null : str(row.column_default);
    const identity = extra.includes("auto_increment");
    const generated = /\bgenerated\b/.test(extra) && !extra.includes("default_generated");
    const udt = mysqlUdt(str(row.data_type), columnType);
    const labels = udt === "enum" ? enumLabelsOf(columnType) : [];
    const spec: ColumnSpec = {
      name,
      dataType: str(row.data_type).toLowerCase(),
      udt,
      nullable: str(row.is_nullable) === "YES",
      hasDefault: columnDefault !== null || identity,
      // An expression default (MySQL 8: `DEFAULT (uuid())`, marked DEFAULT_GENERATED) or a
      // timestamp the engine stamps; a constant default is still generated, or every row
      // would carry it.
      engineFilled:
        identity || generated || extra.includes("default_generated") || /^current_timestamp/i.test(columnDefault ?? ""),
      identity,
      ...(generated ? { generated: true } : {}),
      maxLength: num(row.character_maximum_length),
      numericPrecision: num(row.numeric_precision),
      numericScale: num(row.numeric_scale),
      ...(labels.length > 0 ? { enumLabels: labels } : {}),
      primaryKey: primary.has(key),
      unique: unique.has(key) || primary.has(key),
      ...(references.has(key) ? { references: references.get(key) } : {}),
    };
    if (!tables.has(table)) tables.set(table, { name: table, columns: [] });
    tables.get(table)!.columns.push(spec);
  }
  if (tables.size === 0) throw new SeedDataError(`Database "${schema}" has no tables`, 404);
  return [...tables.values()];
}

function q(name: string): string {
  return quoteIdentifier(name, "mysql");
}

function target(schema: string, table: string): string {
  return `${q(schema)}.${q(table)}`;
}

/**
 * The columns a generated row writes on MySQL: what the engine does not fill better, plus
 * foreign keys, plus a column another table points at that the engine would fill with a
 * default expression - generated here so its value is known without a read - never a
 * generated column, never one a cut reference left null.
 */
export function mysqlWrittenColumns(table: TableSpec, softened: Set<string>, wanted: Set<string>): ColumnSpec[] {
  return table.columns.filter(
    (c) =>
      !c.generated &&
      !softened.has(`${table.name}.${c.name}`) &&
      (!c.engineFilled || c.references !== undefined || (wanted.has(c.name) && !c.identity)),
  );
}

/** The INSERT of one batch of generated rows; `INSERT ... () VALUES ()` when nothing is written. */
export function mysqlInsert(
  schema: string,
  table: TableSpec,
  columns: ColumnSpec[],
  rows: readonly (readonly unknown[])[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  if (columns.length === 0) {
    return { sql: `INSERT INTO ${target(schema, table.name)} () VALUES ${rows.map(() => "()").join(", ")}`, params };
  }
  const tuples = rows.map((values) => {
    params.push(...values);
    return `(${values.map(() => "?").join(", ")})`;
  });
  return {
    sql: `INSERT INTO ${target(schema, table.name)} (${columns.map((c) => q(c.name)).join(", ")}) VALUES ${tuples.join(", ")}`,
    params,
  };
}

/** The last `count` values the engine handed an AUTO_INCREMENT column: the batch just inserted. */
export function mysqlReadBack(schema: string, table: TableSpec, column: string, count: number): string {
  return `SELECT ${q(column)} AS ${q(column)} FROM ${target(schema, table.name)} ORDER BY ${q(column)} DESC LIMIT ${count}`;
}

/** Empty the tables, children first, and reset every AUTO_INCREMENT counter, in the order to run. */
export function mysqlEmptyStatements(schema: string, order: readonly TableSpec[]): string[] {
  const statements = [...order].reverse().map((t) => `DELETE FROM ${target(schema, t.name)}`);
  for (const table of order) {
    if (table.columns.some((c) => c.identity))
      statements.push(`ALTER TABLE ${target(schema, table.name)} AUTO_INCREMENT = 1`);
  }
  return statements;
}

/** How many sampled parents a copy's WHERE lists: bounded, the driver binds each as its own placeholder. */
export const MYSQL_MAX_IN = 1_000;

/** A random subset of a pool, at most MYSQL_MAX_IN values, so an IN list stays bound. */
export function boundedPool(pool: readonly unknown[]): unknown[] {
  if (pool.length <= MYSQL_MAX_IN) return [...pool];
  const chosen = new Set<number>();
  while (chosen.size < MYSQL_MAX_IN) chosen.add(Math.floor(Math.random() * pool.length));
  return [...chosen].map((i) => pool[i]);
}

/** The columns a copy carries on MySQL: every column but a generated one, which the engine computes. */
export function mysqlCopiedColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => !c.generated);
}

/** The SELECT that samples one table on MySQL: the copied columns, filtered to sampled parents, at random, bounded. */
export function mysqlSample(
  schema: string,
  table: TableSpec,
  count: number,
  pools: { get(table: string, column: string): unknown[] | undefined },
  softened: Set<string>,
): { sql: string; params: unknown[] } | { missing: ColumnSpec } {
  const params: unknown[] = [];
  const where: string[] = [];
  for (const col of table.columns) {
    if (!col.references || softened.has(`${table.name}.${col.name}`)) continue;
    const pool = pools.get(col.references.table, col.references.column);
    if (!pool || pool.length === 0) {
      if (!col.nullable) return { missing: col };
      where.push(`${q(col.name)} IS NULL`);
      continue;
    }
    const listed = boundedPool(pool);
    params.push(...listed);
    const list = `${q(col.name)} IN (${listed.map(() => "?").join(", ")})`;
    where.push(col.nullable ? `(${q(col.name)} IS NULL OR ${list})` : list);
  }
  const columns = mysqlCopiedColumns(table)
    .map((c) => q(c.name))
    .join(", ");
  const sql = `SELECT ${columns} FROM ${target(schema, table.name)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY RAND() LIMIT ${count}`;
  return { sql, params };
}

/** The INSERT of copied rows on MySQL: the source's own keys, an AUTO_INCREMENT column written as it was. */
export function mysqlInsertCopied(
  schema: string,
  table: TableSpec,
  rows: Record<string, unknown>[],
  softened: Set<string>,
): { sql: string; params: unknown[] } {
  const columns = mysqlCopiedColumns(table);
  const params: unknown[] = [];
  const tuples = rows.map(
    (row) =>
      `(${columns
        .map((c) => {
          params.push(softened.has(`${table.name}.${c.name}`) ? null : (row[c.name] ?? null));
          return "?";
        })
        .join(", ")})`,
  );
  return {
    sql: `INSERT INTO ${target(schema, table.name)} (${columns.map((c) => q(c.name)).join(", ")}) VALUES ${tuples.join(", ")}`,
    params,
  };
}
