import { randomUUID } from "node:crypto";
import { emitAuditEvent } from "@/lib/audit";
import { activeFreeze } from "@/lib/freezes/store";
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed";
import { quoteIdentifier } from "@/lib/sql/identifier";
import type { QueryResult } from "@/lib/db/types";
import type { ColumnSpec, TableSpec } from "./catalog";
import { type SeedEngine, seedEngineOf } from "./engine";
import { SeedDataError } from "./errors";
import { copyTable, type CopySource } from "./copy";
import { valueFor, type Pools } from "./generators";
import { mysqlEmptyStatements, mysqlInsert, mysqlReadBack, mysqlWrittenColumns } from "./mysql";
import { MAX_ROWS_PER_TABLE, orderTables } from "./plan";
import { PRODUCTION_SEED_REFUSAL } from "./policy";

/**
 * The seed job (docs/CONTEXT.md §4.23): the tables in dependency order, each filled in
 * batches of bound rows, the keys the engine handed back kept as the pool the next table's
 * foreign keys draw from. Runs in this process after the request that started it answered,
 * one job per datasource at a time, and reports its progress per table to whoever asks for
 * it. Never on production, never inside a freeze window; PostgreSQL and MySQL (the MySQL
 * statements in `mysql.ts`: no RETURNING, no TRUNCATE CASCADE, `?` binds).
 */
export interface SeedTableProgress {
  name: string;
  target: number;
  inserted: number;
  error?: string;
}

export type SeedMode = "generate" | "copy";

export interface SeedRun {
  id: string;
  datasourceId: string;
  datasourceName: string;
  schema: string;
  mode: SeedMode;
  /** The datasource the sample came from, in copy mode. */
  sourceName?: string;
  truncated: boolean;
  status: "queued" | "running" | "done" | "failed";
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  tables: SeedTableProgress[];
}

type Runner = { query(sql: string, params?: unknown[]): Promise<QueryResult> };

const RUNS_KEY = Symbol.for("dbportal.seed-data-runs");
const MAX_KEPT_RUNS = 50;
/** Bound parameters PostgreSQL takes in one statement, with room to spare; MySQL's prepared statements take 65535. */
const MAX_PARAMS = 60_000;
export const MAX_BATCH_ROWS = 500;

function runs(): Map<string, SeedRun> {
  const holder = globalThis as unknown as { [RUNS_KEY]?: Map<string, SeedRun> };
  if (!holder[RUNS_KEY]) holder[RUNS_KEY] = new Map();
  return holder[RUNS_KEY];
}

/** Tests only. */
export function resetSeedRuns(): void {
  delete (globalThis as unknown as { [RUNS_KEY]?: Map<string, SeedRun> })[RUNS_KEY];
}

export function getSeedRun(id: string): SeedRun | null {
  return runs().get(id) ?? null;
}

export function seedAllowed(connection: Pick<ManagedConnection, "environment" | "type">): string | null {
  if (!seedEngineOf(connection.type))
    return "Seeding from the schema is available on PostgreSQL and MySQL datasources only";
  if (connection.environment === "production") return PRODUCTION_SEED_REFUSAL;
  return null;
}

/** Every refusal that does not need the catalog, in one place for both routes. */
export async function assertSeedable(connection: ManagedConnection): Promise<void> {
  const why = seedAllowed(connection);
  if (why) throw new SeedDataError(why, 403);
  const frozen = await activeFreeze(connection.seedId ?? connection.id);
  if (frozen)
    throw new SeedDataError(`Writes on "${connection.name}" are frozen until ${frozen.until}: ${frozen.reason}`, 403);
}

class PoolMap implements Pools {
  private readonly values = new Map<string, unknown[]>();
  get(table: string, column: string) {
    return this.values.get(`${table}.${column}`);
  }
  /** How many rows a parent table put in its pools: the count a child's ratio multiplies. */
  size(table: string): number {
    let most = 0;
    for (const [key, values] of this.values) if (key.startsWith(`${table}.`)) most = Math.max(most, values.length);
    return most;
  }
  add(table: string, column: string, value: unknown) {
    const key = `${table}.${column}`;
    if (!this.values.has(key)) this.values.set(key, []);
    this.values.get(key)!.push(value);
  }
}

/** The columns other tables point at, per table: their values are kept as they are generated or returned. */
function referencedColumns(tables: TableSpec[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const table of tables) {
    for (const col of table.columns) {
      if (!col.references) continue;
      if (!out.has(col.references.table)) out.set(col.references.table, new Set());
      out.get(col.references.table)!.add(col.references.column);
    }
  }
  return out;
}

function q(name: string, engine: SeedEngine = "postgres"): string {
  return quoteIdentifier(name, engine);
}

/** The columns the seed writes: everything the engine does not fill better itself, plus foreign keys the engine cannot guess. */
function writtenColumns(table: TableSpec, softened: Set<string>): ColumnSpec[] {
  return table.columns.filter((c) => (!c.engineFilled || c.references) && !softened.has(`${table.name}.${c.name}`));
}

async function fillTable(
  runner: Runner,
  engine: SeedEngine,
  schema: string,
  table: TableSpec,
  target: number,
  offset: number,
  pools: PoolMap,
  wanted: Set<string>,
  softened: Set<string>,
  progress: SeedTableProgress,
): Promise<void> {
  const columns = engine === "mysql" ? mysqlWrittenColumns(table, softened, wanted) : writtenColumns(table, softened);
  const returning = [...wanted].filter((name) => table.columns.some((c) => c.name === name));
  const batchRows =
    columns.length === 0
      ? MAX_BATCH_ROWS
      : Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(MAX_PARAMS / columns.length)));
  const target_ = q(schema) + "." + q(table.name);
  for (let done = 0; done < target; done += batchRows) {
    const count = Math.min(batchRows, target - done);
    const params: unknown[] = [];
    const tuples: string[] = [];
    const generated: unknown[][] = [];
    for (let i = 0; i < count; i++) {
      const n = offset + done + i;
      const values = columns.map((c) => valueFor(c, n, pools));
      // A required reference with nothing to point at is the one thing generation cannot invent.
      const missing = columns.find((c, idx) => c.references && !c.nullable && values[idx] === null);
      if (missing)
        throw new Error(
          `"${table.name}.${missing.name}" needs a row in "${missing.references!.table}", which has none`,
        );
      generated.push(values);
      tuples.push(`(${values.map((_v, idx) => `$${params.length + idx + 1}`).join(", ")})`);
      params.push(...values);
    }
    if (engine === "mysql") {
      // The values written here are known; what the engine numbered is read back, the
      // batch's own rows being the last `count` by that column.
      const insert = mysqlInsert(schema, table, columns, generated);
      await runner.query(insert.sql, insert.params);
      for (const name of returning) {
        const at = columns.findIndex((c) => c.name === name);
        if (at >= 0) {
          for (const values of generated) pools.add(table.name, name, values[at]);
          continue;
        }
        const back = await runner.query(mysqlReadBack(schema, table, name, count));
        for (const row of [...back.rows].reverse()) pools.add(table.name, name, row[name]);
      }
      progress.inserted += count;
      continue;
    }
    const sql =
      columns.length === 0
        ? `INSERT INTO ${target_} SELECT FROM generate_series(1, ${count})${returning.length ? ` RETURNING ${returning.map((name) => q(name)).join(", ")}` : ""}`
        : `INSERT INTO ${target_} (${columns.map((c) => q(c.name)).join(", ")}) VALUES ${tuples.join(", ")}${returning.length ? ` RETURNING ${returning.map((name) => q(name)).join(", ")}` : ""}`;
    const result = await runner.query(sql, params);
    for (const row of result.rows) for (const name of returning) pools.add(table.name, name, row[name]);
    progress.inserted += count;
  }
}

export interface StartSeedInput {
  connection: ManagedConnection;
  runner: Runner;
  schema: string;
  tables: TableSpec[];
  /** `generate` (the default) or `copy` a masked sample from `source` (docs/CONTEXT.md §4.31). */
  mode?: SeedMode;
  source?: CopySource;
  /** Rows per parent row for a child table, in place of its count. */
  ratios?: Map<string, number>;
  /** The run's id, when the caller already has one (a queue job's, §4.40); fresh otherwise. */
  runId?: string;
  counts: Map<string, number>;
  truncate: boolean;
  actor: string;
}

/** Start the job and answer its record at once; the work goes on after the response. */
function prepare(input: StartSeedInput): { run: SeedRun; order: TableSpec[]; softened: Set<string> } {
  const datasourceId = input.connection.seedId ?? input.connection.id;
  for (const other of runs().values()) {
    if (other.datasourceId === datasourceId && other.status === "running") {
      throw new SeedDataError(`A seed is already running on "${input.connection.name}"`, 409);
    }
  }
  const { order, softened } = orderTables(input.tables);
  const run: SeedRun = {
    id: input.runId ?? randomUUID(),
    datasourceId,
    datasourceName: input.connection.name,
    schema: input.schema,
    mode: input.mode ?? "generate",
    ...(input.source ? { sourceName: input.source.name } : {}),
    truncated: input.truncate,
    status: "running",
    startedBy: input.actor,
    startedAt: new Date().toISOString(),
    tables: order.map((t) => ({ name: t.name, target: input.counts.get(t.name) ?? 0, inserted: 0 })),
  };
  const all = runs();
  all.set(run.id, run);
  if (all.size > MAX_KEPT_RUNS) {
    const oldest = [...all.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (oldest) all.delete(oldest.id);
  }
  emitAuditEvent({
    type: "data_seed",
    action: "started",
    target: datasourceId,
    user: input.actor,
    result: "success",
    connectionName: input.connection.name,
    details: `${input.source ? `copied from ${input.source.name}, ` : ""}${run.tables.length} tables, ${[...input.counts.values()].reduce((a, b) => a + b, 0)} rows${input.ratios?.size ? `, ${input.ratios.size} by ratio` : ""}${input.truncate ? ", tables emptied first" : ""}`,
  });
  return { run, order, softened };
}

/** Start a run in this process and answer at once; progress is read back by id (§4.23). */
export function startSeedRun(input: StartSeedInput): SeedRun {
  const { run, order, softened } = prepare(input);
  void execute(run, input, order, softened);
  return run;
}

/**
 * Run to the end, here, for a worker (§4.40): the same run, with a snapshot handed to
 * `onProgress` after each table so whoever reads the queue sees the tables fill.
 */
export async function runSeedNow(
  input: StartSeedInput,
  onProgress?: (run: SeedRun) => Promise<void>,
): Promise<SeedRun> {
  const { run, order, softened } = prepare(input);
  await execute(run, input, order, softened, onProgress);
  return run;
}

async function execute(
  run: SeedRun,
  input: StartSeedInput,
  order: TableSpec[],
  softened: Set<string>,
  onProgress?: (run: SeedRun) => Promise<void>,
): Promise<void> {
  const pools = new PoolMap();
  const wanted = referencedColumns(order);
  const engine: SeedEngine = seedEngineOf(input.connection.type) ?? "postgres";
  // One offset per run so unique columns do not collide with the last run's values.
  const offset = (Date.now() % 1_000_000) * 1_000;
  let failed = false;
  try {
    if (input.truncate) {
      if (engine === "mysql") {
        for (const statement of mysqlEmptyStatements(input.schema, order)) await input.runner.query(statement);
      } else {
        const names = order.map((t) => `${q(input.schema)}.${q(t.name)}`).join(", ");
        await input.runner.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
      }
    }
    for (const table of order) {
      const progress = run.tables.find((t) => t.name === table.name)!;
      try {
        // A ratio: the parent's rows, as they landed in the pools, times it.
        const ratio = input.ratios?.get(table.name);
        if (ratio !== undefined) {
          const parent = table.columns.find((c) => c.references && !softened.has(`${table.name}.${c.name}`))?.references
            ?.table;
          progress.target = Math.min(MAX_ROWS_PER_TABLE, (parent ? pools.size(parent) : 0) * ratio);
        }
        if (input.mode === "copy" && input.source) {
          progress.inserted += await copyTable(
            input.source,
            input.runner,
            input.schema,
            table,
            progress.target,
            pools,
            wanted.get(table.name) ?? new Set(),
            softened,
            run.startedBy,
            Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(MAX_PARAMS / Math.max(1, table.columns.length)))),
            engine,
          );
        } else {
          await fillTable(
            input.runner,
            engine,
            input.schema,
            table,
            progress.target,
            offset,
            pools,
            wanted.get(table.name) ?? new Set(),
            softened,
            progress,
          );
        }
      } catch (error) {
        failed = true;
        progress.error = error instanceof Error ? error.message : "The table could not be filled";
        logger.warn("Seed table failed", { route: "seed-data/run", runId: run.id, table: table.name });
      }
      // A snapshot the reader may lose is not the run's failure.
      await onProgress?.(run).catch((error: unknown) => {
        logger.warn("Seed progress not written", {
          route: "seed-data/run",
          runId: run.id,
          error: (error as Error).name,
        });
      });
    }
  } catch (error) {
    failed = true;
    logger.error("Seed run failed before its tables", error, { route: "seed-data/run", runId: run.id });
    for (const t of run.tables) if (!t.error) t.error = "The run stopped before this table";
  }
  run.status = failed ? "failed" : "done";
  run.finishedAt = new Date().toISOString();
  const inserted = run.tables.reduce((a, t) => a + t.inserted, 0);
  emitAuditEvent({
    type: "data_seed",
    action: failed ? "failed" : "finished",
    target: run.datasourceId,
    user: run.startedBy,
    result: failed ? "failure" : "success",
    ...(failed ? { reason: "execution_failed" as const } : {}),
    connectionName: run.datasourceName,
    details: `${inserted} rows into ${run.tables.filter((t) => t.inserted > 0).length} tables`,
    rows: inserted,
  });
}
