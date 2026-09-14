import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import type { DatabaseType } from "@/lib/types";

/**
 * Guardrails (docs/CONTEXT.md §4.15): the statements that erase a table or a large part of
 * it in one go and that a person who may write should still not run alone. Four shapes,
 * each a closed word a reviewer and the audit trail can read: a DELETE or an UPDATE with
 * no WHERE, a DROP, a TRUNCATE. Anything else is left to the write rule.
 *
 * Read from the statement's text under the engine's grammar, the way the read-only gate
 * reads it: comments and string literals are blanked before the WHERE is looked for, so
 * `DELETE FROM t -- where?` and `DELETE FROM t WHERE note = 'x'` are told apart. A
 * datasource may opt out with `guardrails: false`; an engine whose statements are not SQL
 * text has nothing here to read and gets none.
 */
export type Guardrail = "delete_without_where" | "update_without_where" | "drop" | "truncate";

export const GUARDRAIL_LABEL: Record<Guardrail, string> = {
  delete_without_where: "DELETE without WHERE",
  update_without_where: "UPDATE without WHERE",
  drop: "DROP",
  truncate: "TRUNCATE",
};

/** The statement's code with comments and string literals blanked, keeping the length. */
function codeOnly(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"]|"")*"/g, (m) => " ".repeat(m.length));
}

function leadingKeyword(code: string): string | null {
  const match = code.match(/^\s*([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : null;
}

export function dangerOf(sql: string, type?: DatabaseType): Guardrail | null {
  const code = codeOnly(sql);
  const keyword = leadingKeyword(code);
  if (keyword === "DROP") return "drop";
  if (keyword === "TRUNCATE") return "truncate";
  const shape = analyzeQuery(sql, type).type;
  if (shape !== "DELETE" && shape !== "UPDATE") return null;
  if (/\bWHERE\b/i.test(code)) return null;
  return shape === "DELETE" ? "delete_without_where" : "update_without_where";
}

/** The first guardrail any of the statements trips, or null. */
export function firstGuardrail(statements: readonly string[], type?: DatabaseType): Guardrail | null {
  for (const sql of statements) {
    const found = dangerOf(sql, type);
    if (found) return found;
  }
  return null;
}
