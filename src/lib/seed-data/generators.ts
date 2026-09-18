import { randomUUID } from "node:crypto";
import type { ColumnSpec } from "./catalog";

/**
 * A value for one column of one row (docs/CONTEXT.md §4.23): typed as the engine types the
 * column, named as the column's name suggests where the name is a common one, unique where
 * the column is, inside the length the column allows, and null now and then where null is
 * allowed. `n` is the row's number within the run, offset so two runs do not collide on a
 * unique column; the randomness is for shape, not for identity.
 */
export interface Pools {
  /** Values already in the parent column a foreign key points at, keyed `table.column`. */
  get(table: string, column: string): unknown[] | undefined;
}

const FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elena", "Fabio", "Gisele", "Hugo", "Iris", "Joao", "Karen", "Luis"];
const LAST = ["Silva", "Souza", "Oliveira", "Santos", "Pereira", "Lima", "Costa", "Rocha", "Almeida", "Nunes"];
const CITIES = ["Sao Paulo", "Lisboa", "Porto", "Curitiba", "Recife", "Madrid", "Berlin", "Austin", "Toronto", "Osaka"];
const COUNTRIES = ["BR", "PT", "ES", "DE", "US", "CA", "JP", "AR", "MX", "FR"];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const STATUSES = ["active", "pending", "archived", "cancelled", "done"];

const pick = <T>(list: readonly T[], n: number): T => list[Math.abs(n) % list.length];
const rand = (max: number) => Math.floor(Math.random() * max);

function cut(text: string, max: number | null): string {
  return max !== null && text.length > max ? text.slice(0, max) : text;
}

function textFor(column: ColumnSpec, n: number): string {
  const name = column.name.toLowerCase();
  const suffix = column.unique ? `-${n}` : "";
  let value: string;
  if (name.includes("email")) value = `user${n}@example.test`;
  else if (name.includes("first")) value = pick(FIRST, n);
  else if (name.includes("last") || name.includes("surname")) value = pick(LAST, n);
  else if (name.endsWith("name") || name === "title") value = `${pick(FIRST, n)} ${pick(LAST, n + rand(10))}${suffix}`;
  else if (name.includes("phone")) value = `+55 11 9${String(10_000_000 + (n % 90_000_000)).padStart(8, "0")}`;
  else if (name.includes("city")) value = pick(CITIES, n);
  else if (name.includes("country")) value = pick(COUNTRIES, n);
  else if (name.includes("url") || name.includes("link")) value = `https://example.test/${pick(WORDS, n)}/${n}`;
  else if (name.includes("status") || name.includes("state")) value = pick(STATUSES, n + rand(5));
  else if (name.includes("description") || name.includes("note") || name.includes("comment") || name.includes("body"))
    value = `${pick(WORDS, n)} ${pick(WORDS, n + 1)} ${pick(WORDS, n + 2)} ${pick(WORDS, n + 3)}`;
  else if (name.includes("code") || name.includes("sku") || name.includes("slug")) value = `${pick(WORDS, n)}-${n}`;
  else value = `${pick(WORDS, n)}${suffix || ` ${n % 1000}`}`;
  return cut(value, column.maxLength);
}

function dateAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000 - rand(86_400_000));
}

/** Null for a nullable column now and then, so the shape has holes like real data. */
function sometimesNull(column: ColumnSpec, n: number): boolean {
  return column.nullable && !column.unique && n % 10 === 0;
}

export function valueFor(column: ColumnSpec, n: number, pools: Pools): unknown {
  if (column.references) {
    const pool = pools.get(column.references.table, column.references.column);
    if (!pool || pool.length === 0) return null;
    return pool[rand(pool.length)];
  }
  if (sometimesNull(column, n)) return null;
  if (column.enumLabels && column.enumLabels.length > 0)
    return pick(column.enumLabels, n + rand(column.enumLabels.length));
  const { udt } = column;
  if (udt.startsWith("_")) return "{}";
  switch (udt) {
    case "int1":
      return column.unique ? (n % 120) + 1 : rand(100) + 1;
    case "year":
      return 1990 + (column.unique ? n % 100 : rand(36));
    case "int2":
      return column.unique ? (n % 32_000) + 1 : rand(30_000) + 1;
    case "int4":
    case "int8":
      return column.unique ? n : rand(1_000_000) + 1;
    case "numeric":
    case "float4":
    case "float8":
    case "money": {
      const scale = column.numericScale ?? 2;
      return column.unique ? n + 0.5 : Number((Math.random() * 10_000).toFixed(Math.min(scale, 6)));
    }
    case "bool":
      return rand(2) === 0;
    case "uuid":
      return randomUUID();
    case "date":
      return dateAgo(rand(365)).toISOString().slice(0, 10);
    case "timestamp":
    case "timestamptz":
      return dateAgo(rand(365)).toISOString();
    // MySQL's DATETIME/TIMESTAMP: a Date, which the driver spells the way the server reads
    // it; an ISO string with its trailing Z is refused there.
    case "datetime":
      return dateAgo(rand(365));
    case "time":
    case "timetz":
      return `${String(rand(24)).padStart(2, "0")}:${String(rand(60)).padStart(2, "0")}:00`;
    case "interval":
      return `${rand(30) + 1} days`;
    case "json":
    case "jsonb":
      return JSON.stringify({ n, tag: pick(WORDS, n) });
    case "inet":
    case "cidr":
      return `10.${rand(255)}.${rand(255)}.${rand(254) + 1}`;
    case "bytea":
      return column.nullable ? null : Buffer.from([0]);
    case "text":
    case "varchar":
    case "bpchar":
    case "citext":
    case "name":
      return textFor(column, n);
    default:
      return column.nullable ? null : textFor(column, n);
  }
}
