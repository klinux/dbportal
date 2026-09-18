import type { QueryResult } from "@/lib/db/types";
import type { SeedEngine } from "./engine";
import { SeedDataError } from "./errors";
import { readMysqlCatalog, readMysqlSchemaName } from "./mysql";
import { isPortalTable } from "./portal-tables";

/**
 * What the seed needs to know about a schema (docs/CONTEXT.md §4.23), read from PostgreSQL's
 * own catalog: every table, its columns as the engine types them, which columns the engine
 * fills itself, the single-column primary and unique keys, the foreign keys, and the labels
 * of every enum. Read once per plan; the plan and the generators are pure over this.
 */
export interface ColumnSpec {
  name: string;
  /** `information_schema.columns.data_type`, lower-case. */
  dataType: string;
  /** `udt_name`: the concrete type - `int4`, `_text` for an array, the enum's name. */
  udt: string;
  nullable: boolean;
  /** The column has a default of any kind. */
  hasDefault: boolean;
  /**
   * The engine fills it better than a generator would: an identity column, a serial, or a
   * default that is a call (`now()`, `gen_random_uuid()`). A constant default (`'open'`) is
   * still generated, or every row would carry it.
   */
  engineFilled: boolean;
  identity: boolean;
  /** MySQL: a `VIRTUAL` or `STORED` generated column, which can be neither written nor copied. */
  generated?: boolean;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  /** Labels when the column is an enum. */
  enumLabels?: string[];
  primaryKey: boolean;
  unique: boolean;
  /** Where the value must come from: another table's column. */
  references?: { table: string; column: string };
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[];
}

type Runner = { query(sql: string, params?: unknown[]): Promise<QueryResult> };

const TABLES_SQL = `
SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
       c.is_identity, c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.ordinal_position
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.ordinal_position`;

const KEYS_SQL = `
SELECT tc.table_name, tc.constraint_type, kcu.column_name, tc.constraint_name,
       (SELECT count(*) FROM information_schema.key_column_usage k2
         WHERE k2.constraint_name = tc.constraint_name AND k2.table_schema = tc.table_schema) AS width
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
WHERE tc.table_schema = $1 AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')`;

const FKS_SQL = `
SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'`;

const ENUMS_SQL = `
SELECT t.typname AS name, e.enumlabel AS label
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1 ORDER BY t.typname, e.enumsortorder`;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function readSchemaName(value: unknown, engine: SeedEngine = "postgres", database?: string): string {
  if (engine === "mysql") return readMysqlSchemaName(value, database);
  if (value === undefined || value === null || value === "") return "public";
  if (typeof value !== "string" || !SCHEMA_NAME.test(value)) {
    throw new SeedDataError("schema must be a lower-case identifier", 400);
  }
  return value;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export { isPortalTable, PORTAL_TABLES } from "./portal-tables";

/** Every table of `schema` with what the seed needs, or a refusal when there is none; MySQL through its own reads. */
export async function readCatalog(
  runner: Runner,
  schema: string,
  engine: SeedEngine = "postgres",
): Promise<TableSpec[]> {
  if (engine === "mysql") return readMysqlCatalog(runner, schema);
  const [columns, keys, fks, enums] = await Promise.all([
    runner.query(TABLES_SQL, [schema]),
    runner.query(KEYS_SQL, [schema]),
    runner.query(FKS_SQL, [schema]),
    runner.query(ENUMS_SQL, [schema]),
  ]);
  const labels = new Map<string, string[]>();
  for (const row of enums.rows) {
    const name = str(row.name);
    labels.set(name, [...(labels.get(name) ?? []), str(row.label)]);
  }
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
    const udt = str(row.udt_name);
    const columnDefault = str(row.column_default);
    const identity = str(row.is_identity) === "YES" || /nextval\(/.test(columnDefault);
    const spec: ColumnSpec = {
      name,
      dataType: str(row.data_type).toLowerCase(),
      udt,
      nullable: str(row.is_nullable) === "YES",
      hasDefault: columnDefault !== "" || identity,
      engineFilled: identity || /\w\(/.test(columnDefault),
      identity,
      maxLength: num(row.character_maximum_length),
      numericPrecision: num(row.numeric_precision),
      numericScale: num(row.numeric_scale),
      ...(labels.has(udt) ? { enumLabels: labels.get(udt) } : {}),
      primaryKey: primary.has(key),
      unique: unique.has(key) || primary.has(key),
      ...(references.has(key) ? { references: references.get(key) } : {}),
    };
    if (!tables.has(table)) tables.set(table, { name: table, columns: [] });
    tables.get(table)!.columns.push(spec);
  }
  if (tables.size === 0) throw new SeedDataError(`Schema "${schema}" has no tables`, 404);
  return [...tables.values()];
}
