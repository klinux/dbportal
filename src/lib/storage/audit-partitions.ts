/**
 * The periods the audit record is partitioned by (docs/CONTEXT.md §4.43): a month by
 * default, a week where the volume or a short retention asks for it. Pure: a period is a
 * name and two instants, and the provider turns them into partitions. Names carry the
 * period's first day, so `\\dt audit_events_*` reads as a calendar.
 */
export type PartitionKind = "month" | "week";

export const DEFAULT_PARTITIONS_AHEAD = 2;
export const AUDIT_TABLE = "audit_events";
export const LEGACY_PARTITION = "audit_events_legacy";

export interface Period {
  name: string;
  /** Inclusive, ISO. */
  from: string;
  /** Exclusive, ISO. */
  to: string;
}

export function partitionKind(env: string | undefined = process.env.AUDIT_PARTITION): PartitionKind {
  return env?.trim().toLowerCase() === "week" ? "week" : "month";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The period `date` falls in: a calendar month, or a week from Monday. */
export function periodOf(date: Date, kind: PartitionKind): Period {
  if (kind === "week") {
    const day = (date.getUTCDay() + 6) % 7; // Monday = 0
    const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 7));
    return {
      name: `${AUDIT_TABLE}_w${from.getUTCFullYear()}_${pad(from.getUTCMonth() + 1)}_${pad(from.getUTCDate())}`,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return {
    name: `${AUDIT_TABLE}_p${from.getUTCFullYear()}_${pad(from.getUTCMonth() + 1)}`,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

/** The current period and `ahead` more, so the next boundary never finds no partition. */
export function periodsAhead(now: Date, kind: PartitionKind, ahead = DEFAULT_PARTITIONS_AHEAD): Period[] {
  const periods: Period[] = [];
  let cursor = periodOf(now, kind);
  for (let i = 0; i <= ahead; i++) {
    periods.push(cursor);
    cursor = periodOf(new Date(cursor.to), kind);
  }
  return periods;
}

export interface PartitionBounds {
  name: string;
  /** null for MINVALUE: the legacy partition, everything before the first period. */
  from: string | null;
  to: string;
}

/**
 * The bounds off `pg_get_expr(relpartbound)`: `FOR VALUES FROM ('2026-09-01 00:00:00+00')
 * TO ('2026-10-01 00:00:00+00')`, or `FROM (MINVALUE)` for the legacy partition.
 */
export function parseBounds(name: string, expr: string): PartitionBounds | null {
  const m = /FROM \((MINVALUE|'([^']+)')\) TO \('([^']+)'\)/.exec(expr);
  if (!m) return null;
  const iso = (s: string) => new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString();
  return { name, from: m[1] === "MINVALUE" ? null : iso(m[2]), to: iso(m[3]) };
}

/** Whether an existing partition already holds the instant. */
export function covers(bounds: PartitionBounds, instant: string): boolean {
  return (bounds.from === null || bounds.from <= instant) && instant < bounds.to;
}

/** A `TIMESTAMPTZ` literal for DDL, which takes no bound parameters; the instant is ours, never a request's. */
export function tsLiteral(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(iso)) throw new Error(`not an ISO instant: ${iso}`);
  return `'${iso}'`;
}
