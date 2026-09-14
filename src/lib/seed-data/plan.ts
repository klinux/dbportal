import type { TableSpec } from "./catalog";
import { SeedDataError } from "./errors";

/**
 * The order the tables are filled in (docs/CONTEXT.md §4.23): a parent before the tables
 * that point at it, so every foreign key finds a row to point at. A reference to the table
 * itself, and a nullable reference that closes a cycle, are left null rather than ordered;
 * a cycle of required references cannot be filled and is refused with the tables named.
 */
export interface PlanTable {
  name: string;
  columns: number;
  /** The tables this one must come after. */
  dependsOn: string[];
  rows: number;
}

export const DEFAULT_ROWS = 100;
export const MAX_ROWS_PER_TABLE = 1_000_000;

export function orderTables(tables: TableSpec[]): { order: TableSpec[]; softened: Set<string> } {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const softened = new Set<string>();
  const deps = new Map<string, Set<string>>();
  for (const table of tables) {
    const set = new Set<string>();
    for (const col of table.columns) {
      const ref = col.references;
      if (!ref || !byName.has(ref.table) || ref.table === table.name) {
        if (ref && ref.table === table.name) softened.add(`${table.name}.${col.name}`);
        continue;
      }
      set.add(ref.table);
    }
    deps.set(table.name, set);
  }
  const order: TableSpec[] = [];
  const placed = new Set<string>();
  let remaining = tables.map((t) => t.name);
  while (remaining.length > 0) {
    const ready = remaining.filter((name) => [...deps.get(name)!].every((d) => placed.has(d)));
    if (ready.length > 0) {
      for (const name of ready) {
        order.push(byName.get(name)!);
        placed.add(name);
      }
      remaining = remaining.filter((name) => !placed.has(name));
      continue;
    }
    // A cycle: drop one nullable reference among the stuck tables and go on; otherwise refuse.
    let cut = false;
    for (const name of remaining) {
      const table = byName.get(name)!;
      const col = table.columns.find(
        (c) => c.references && c.nullable && !placed.has(c.references.table) && c.references.table !== name,
      );
      if (col) {
        deps.get(name)!.delete(col.references!.table);
        softened.add(`${name}.${col.name}`);
        cut = true;
        break;
      }
    }
    if (!cut) {
      throw new SeedDataError(
        `Tables reference each other through required columns and cannot be ordered: ${remaining.join(", ")}`,
        422,
      );
    }
  }
  return { order, softened };
}

export function buildPlan(tables: TableSpec[], rows = DEFAULT_ROWS): PlanTable[] {
  const { order } = orderTables(tables);
  return order.map((table) => ({
    name: table.name,
    columns: table.columns.length,
    dependsOn: [
      ...new Set(
        table.columns
          .map((c) => c.references?.table)
          .filter((t): t is string => t !== undefined && t !== table.name && order.some((o) => o.name === t)),
      ),
    ],
    rows,
  }));
}

/** The counts a caller asked for, bounded, one per table of the plan; a table not named keeps the default. */
export function readCounts(value: unknown, plan: PlanTable[]): Map<string, number> {
  const counts = new Map<string, number>();
  const given =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const table of plan) {
    const raw = given[table.name];
    if (raw === undefined) {
      counts.set(table.name, table.rows);
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ROWS_PER_TABLE) {
      throw new SeedDataError(`rows for "${table.name}" must be an integer between 0 and ${MAX_ROWS_PER_TABLE}`, 400);
    }
    counts.set(table.name, n);
  }
  return counts;
}

export const MAX_RATIO = 1_000;

/**
 * Rows per parent row (docs/CONTEXT.md §4.31), for the tables that have a parent: a child
 * with a ratio takes `parent rows × ratio` rows once the parent is filled, in place of its
 * own count. A table without a parent cannot have one.
 */
export function readRatios(value: unknown, plan: PlanTable[]): Map<string, number> {
  const ratios = new Map<string, number>();
  const given =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const table of plan) {
    const raw = given[table.name];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RATIO) {
      throw new SeedDataError(`rows per parent for "${table.name}" must be an integer between 1 and ${MAX_RATIO}`, 400);
    }
    if (table.dependsOn.length === 0) {
      throw new SeedDataError(`"${table.name}" has no parent table to take a ratio from`, 400);
    }
    ratios.set(table.name, n);
  }
  return ratios;
}
