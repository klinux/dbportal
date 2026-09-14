import type { AlertDefinition as Alert, AlertOp } from "./types";

/**
 * The condition of an alert (docs/CONTEXT.md §4.29) against what its read returned. The
 * value is one cell: the named column of the first row, else the first column. A
 * comparison is numeric when both sides are numbers, textual otherwise; `changed` holds
 * when the value differs from the last run's; the two row-count operators look at rows only.
 */
export interface Outcome {
  /** The value read, as text, for the record and the message. */
  value: string | undefined;
  holds: boolean;
}

export function readValue(rows: Record<string, unknown>[], fields: string[], column?: string): unknown {
  const first = rows[0];
  if (!first) return undefined;
  const key = column ?? fields[0];
  return key === undefined ? undefined : first[key];
}

export function asText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function compare(op: AlertOp, actual: unknown, expected: number | string | undefined): boolean {
  const left = typeof actual === "number" ? actual : Number(actual);
  const right = typeof expected === "number" ? expected : Number(expected);
  const numeric = actual !== null && actual !== undefined && !Number.isNaN(left) && !Number.isNaN(right);
  const a = numeric ? left : asText(actual);
  const b = numeric ? right : expected === undefined ? undefined : String(expected);
  if (a === undefined) return false;
  switch (op) {
    case ">":
      return a > (b as number | string);
    case ">=":
      return a >= (b as number | string);
    case "<":
      return a < (b as number | string);
    case "<=":
      return a <= (b as number | string);
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    default:
      return false;
  }
}

export function evaluate(
  alert: Pick<Alert, "op" | "value" | "column">,
  result: { rows: Record<string, unknown>[]; fields: string[]; rowCount?: number },
  previous: string | undefined,
): Outcome {
  const rows = result.rowCount ?? result.rows.length;
  const actual = readValue(result.rows, result.fields, alert.column);
  const value = asText(actual);
  switch (alert.op) {
    case "any_rows":
      return { value, holds: rows > 0 };
    case "no_rows":
      return { value, holds: rows === 0 };
    case "changed":
      return { value, holds: previous !== undefined && value !== previous };
    default:
      return { value, holds: compare(alert.op, actual, alert.value) };
  }
}

/** The condition as a person reads it: `count > 100`, `rows: none`. */
export function describeCondition(alert: Pick<Alert, "op" | "value" | "column">): string {
  const subject = alert.column ?? "value";
  switch (alert.op) {
    case "any_rows":
      return "any row returned";
    case "no_rows":
      return "no row returned";
    case "changed":
      return `${subject} changed since the last run`;
    default:
      return `${subject} ${alert.op} ${alert.value}`;
  }
}
