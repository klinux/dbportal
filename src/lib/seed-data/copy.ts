import { emitAuditEvent } from "@/lib/audit";
import type { QueryResult } from "@/lib/db/types";
import { applyMaskingToRows, detectSensitiveColumnsFromConfig } from "@/lib/data-masking";
import { getServerMaskingConfig } from "@/lib/masking/store";
import { quoteIdentifier } from "@/lib/sql/identifier";
import type { ColumnSpec, TableSpec } from "./catalog";

/**
 * Seed mode 2 (docs/CONTEXT.md §4.31): a sample of another datasource copied across.
 * Each table is sampled from the source - at random, and where it points at a table
 * already sampled, only rows that point at the sampled rows, so every foreign key still
 * finds its parent - masked by the server's masking rules whatever the role (a copy into
 * staging is exactly what masking exists for), and inserted into the target with the
 * source's own keys, so the parents' keys are the pool the children draw from. A column
 * the engine fills is written too (`OVERRIDING SYSTEM VALUE` for an identity), and the
 * table's sequences are moved past the copied keys, so what staging inserts later does
 * not collide. Every sample read is a `query_execution` line on the source.
 */
export type Runner = { query(sql: string, params?: unknown[]): Promise<QueryResult> };

export interface Pools {
  get(table: string, column: string): unknown[] | undefined;
}

function q(name: string): string {
  return quoteIdentifier(name, "postgres");
}

/** The SELECT that samples one table: every column, filtered to the parents sampled, at random, bounded. */
export function sampleStatement(
  schema: string,
  table: TableSpec,
  count: number,
  pools: Pools,
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
    params.push(pool);
    where.push(
      col.nullable
        ? `(${q(col.name)} IS NULL OR ${q(col.name)} = ANY($${params.length}))`
        : `${q(col.name)} = ANY($${params.length})`,
    );
  }
  const columns = table.columns.map((c) => q(c.name)).join(", ");
  const from = `${q(schema)}.${q(table.name)}`;
  const sql = `SELECT ${columns} FROM ${from}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY random() LIMIT ${count}`;
  return { sql, params };
}

/** The INSERT for a batch of copied rows: every column, the engine's own overridden where a column is an identity. */
export function insertStatement(
  schema: string,
  table: TableSpec,
  rows: Record<string, unknown>[],
  softened: Set<string>,
): { sql: string; params: unknown[] } {
  const columns = table.columns;
  const params: unknown[] = [];
  const tuples = rows.map(
    (row) =>
      `(${columns
        .map((c) => {
          // A reference cut to order the tables (a table pointing at itself, a cycle) is left null: its row may not be in the sample.
          params.push(softened.has(`${table.name}.${c.name}`) ? null : (row[c.name] ?? null));
          return `$${params.length}`;
        })
        .join(", ")})`,
  );
  const overriding = columns.some((c) => c.identity) ? " OVERRIDING SYSTEM VALUE" : "";
  const sql = `INSERT INTO ${q(schema)}.${q(table.name)} (${columns.map((c) => q(c.name)).join(", ")})${overriding} VALUES ${tuples.join(", ")}`;
  return { sql, params };
}

/** The sequence-backed columns: an identity, or an integer the engine fills (a serial). */
export function sequenceColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => c.identity || (c.engineFilled && ["int2", "int4", "int8"].includes(c.udt)));
}

/** Move each sequence past the copied keys, where the column has one. */
export async function resetSequences(runner: Runner, schema: string, table: TableSpec): Promise<void> {
  for (const col of sequenceColumns(table)) {
    await runner.query(
      `SELECT setval(s, GREATEST(coalesce((SELECT max(${q(col.name)}) FROM ${q(schema)}.${q(table.name)}), 1), 1)) FROM pg_get_serial_sequence($1, $2) s WHERE s IS NOT NULL`,
      [`${q(schema)}.${q(table.name)}`, col.name],
    );
  }
}

export interface CopySource {
  runner: Runner;
  name: string;
}

/**
 * Copy one table: sample, mask, insert in batches, pool the referenced columns' values,
 * reset the sequences. Returns how many rows were copied; throws where a required
 * reference has nothing sampled to point at, or the engine refuses.
 */
export async function copyTable(
  source: CopySource,
  target: Runner,
  schema: string,
  table: TableSpec,
  count: number,
  pools: Pools & { add(table: string, column: string, value: unknown): void },
  wanted: Set<string>,
  softened: Set<string>,
  actor: string,
  batchRows: number,
): Promise<number> {
  if (count === 0) return 0;
  const statement = sampleStatement(schema, table, count, pools, softened);
  if ("missing" in statement) {
    throw new Error(
      `"${table.name}.${statement.missing.name}" needs a row in "${statement.missing.references!.table}", which has none in the sample`,
    );
  }
  const result = await source.runner.query(statement.sql, statement.params);
  emitAuditEvent({
    type: "query_execution",
    action: "seed_copy",
    target: "seed-data/copy",
    user: actor,
    result: "success",
    connectionName: source.name,
    details: `${table.name}: ${result.rows.length} rows sampled`,
    rows: result.rows.length,
  });
  const config = await getServerMaskingConfig();
  const fields = table.columns.map((c) => c.name);
  const rows = applyMaskingToRows(result.rows, fields, detectSensitiveColumnsFromConfig(fields, config));
  let copied = 0;
  for (let at = 0; at < rows.length; at += batchRows) {
    const batch = rows.slice(at, at + batchRows);
    const insert = insertStatement(schema, table, batch, softened);
    await target.query(insert.sql, insert.params);
    for (const row of batch) for (const name of wanted) if (name in row) pools.add(table.name, name, row[name]);
    copied += batch.length;
  }
  await resetSequences(target, schema, table);
  return copied;
}
