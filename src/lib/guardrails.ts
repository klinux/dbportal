import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import type { DatabaseType } from "@/lib/types";

/**
 * Guardrails (docs/CONTEXT.md §4.15): the statements that erase a table or a large part of
 * it in one go and that a person who may write should still not run alone. Five shapes,
 * each a closed word a reviewer and the audit trail can read: a DELETE or an UPDATE with
 * no WHERE, a DROP, a TRUNCATE, and a grant of privilege. Anything else is left to the
 * write rule.
 *
 * Read from the statement's text under the engine's grammar, the way the read-only gate
 * reads it: comments and string literals are blanked before the WHERE is looked for, so
 * `DELETE FROM t -- where?` and `DELETE FROM t WHERE note = 'x'` are told apart. A
 * datasource may opt out with `guardrails: false`; an engine whose statements are not SQL
 * text has nothing here to read and gets none.
 */
export type Guardrail = "delete_without_where" | "update_without_where" | "drop" | "truncate" | "grant";

export const GUARDRAIL_LABEL: Record<Guardrail, string> = {
  delete_without_where: "DELETE without WHERE",
  update_without_where: "UPDATE without WHERE",
  drop: "DROP",
  truncate: "TRUNCATE",
  grant: "GRANT or REVOKE",
};

/**
 * Statements that change who may do what: GRANT and REVOKE, the identities a privilege is
 * granted to, and the shapes that change a credential. They neither read nor write a row,
 * so the write rule never saw them, and `analyzeQuery` types them as neither a DELETE nor
 * an UPDATE — a privilege change reached the engine having passed no gate at all.
 *
 * Here rather than refused outright because the shape is legitimate: a reviewer approving
 * `GRANT SELECT ON orders TO reporting` is a normal afternoon. What must not happen is it
 * running because nobody was looking.
 */
const PRIVILEGE_ALONE = new Set(["GRANT", "REVOKE"]);

/**
 * `CREATE`/`ALTER` whose subject is an identity, not a table. The optional `OR REPLACE`
 * sits between the verb and the subject (MariaDB); `IF NOT EXISTS` comes after it and does
 * not need skipping. `ALTER DEFAULT PRIVILEGES` is the one that matters most to a reviewer:
 * it grants on every table created from then on, so it is a privilege change even though
 * the word GRANT is not what leads.
 */
const PRIVILEGE_SUBJECT = /^\s*(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:ROLE|USER|GROUP|DEFAULT\s+PRIVILEGES)\b/i;

/**
 * Two-word leaders that change an identity or its credential and lead with neither verb
 * above: MySQL's `RENAME USER a TO b` and `SET PASSWORD FOR …`.
 */
const PRIVILEGE_PAIR = /^\s*(?:RENAME\s+USER|SET\s+PASSWORD)\b/i;

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

/**
 * Whether the statement changes who may do what. Read off the blanked code like the other
 * four, so `SELECT 'grant'` is a SELECT and a leading comment hides nothing.
 */
function changesPrivileges(code: string): boolean {
  const first = leadingKeyword(code);
  if (first !== null && PRIVILEGE_ALONE.has(first)) return true;
  return PRIVILEGE_SUBJECT.test(code) || PRIVILEGE_PAIR.test(code);
}

export function dangerOf(sql: string, type?: DatabaseType): Guardrail | null {
  const code = codeOnly(sql);
  const keyword = leadingKeyword(code);
  if (keyword === "DROP") return "drop";
  if (keyword === "TRUNCATE") return "truncate";
  if (changesPrivileges(code)) return "grant";
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
