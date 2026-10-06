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
export type Guardrail =
  | "delete"
  | "delete_without_where"
  | "update_without_where"
  | "update_always_true"
  | "drop"
  | "truncate"
  | "grant";

export const GUARDRAIL_LABEL: Record<Guardrail, string> = {
  delete: "DELETE",
  delete_without_where: "DELETE without WHERE",
  update_without_where: "UPDATE without WHERE",
  update_always_true: "UPDATE with an always-true WHERE",
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

/** Where an UPDATE's predicate ends: the clauses that may follow a WHERE on the engines served. */
const AFTER_PREDICATE = /\b(?:RETURNING|ORDER\s+BY|LIMIT|OUTPUT)\b[\s\S]*$/i;

/**
 * Whether a WHERE predicate is true of every row by construction: `1=1`, `true`, `1`,
 * `x = x`, a string compared to itself (both blanked by `codeOnly`, so they read as two
 * empty sides), or any of those as a top-level `OR` branch (`WHERE id = 5 OR 1=1`).
 *
 * This is the UPDATE half of the hole the DELETE rule closed by holding every DELETE:
 * `UPDATE t SET c = 1 WHERE 1=1` rewrote every row with no reviewer. Every UPDATE is not
 * held - the single-row edit is what the route exists for - so the spellings that are
 * always true are read instead. It is a list, and a list can be outrun (`WHERE id > 0`);
 * the general case stays open and named in docs/CONTEXT.md §4.15. What is here errs
 * toward holding: two blanked strings compare as equal whether they were, because a
 * review of `WHERE 'a' = 'b'` costs a minute and a missed `WHERE 'a' = 'a'` costs the table.
 */
function alwaysTrueWhere(code: string): boolean {
  const at = code.search(/\bWHERE\b/i);
  if (at < 0) return false;
  const predicate = code
    .slice(at + "WHERE".length)
    .replace(AFTER_PREDICATE, "")
    .replace(/;\s*$/, "");
  return predicateAlwaysTrue(predicate);
}

/** Whether a predicate, or any top-level `OR` branch of it, is true by construction. */
function predicateAlwaysTrue(predicate: string): boolean {
  return topLevelOrBranches(predicate).some((branch) => {
    const text = branch.replace(/\s+/g, " ").trim();
    // A parenthesised branch is a predicate of its own: `id = 5 OR (status = 'x' OR true)`.
    if (/^\(.*\)$/.test(text)) return predicateAlwaysTrue(text.slice(1, -1));
    if (/^(?:true|1)$/i.test(text)) return true;
    const equality = /^(.*?)\s*=\s*(.*)$/.exec(text);
    if (equality === null) return false;
    return equality[1].trim() === equality[2].trim();
  });
}

/** The predicate split on `OR` outside parentheses. */
function topLevelOrBranches(predicate: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let start = 0;
  const re = /[()]|\bOR\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(predicate)) !== null) {
    if (match[0] === "(") depth += 1;
    else if (match[0] === ")") depth -= 1;
    else if (depth === 0) {
      branches.push(predicate.slice(start, match.index));
      start = match.index + match[0].length;
    }
  }
  branches.push(predicate.slice(start));
  return branches;
}

export function dangerOf(sql: string, type?: DatabaseType): Guardrail | null {
  const code = codeOnly(sql);
  const keyword = leadingKeyword(code);
  if (keyword === "DROP") return "drop";
  if (keyword === "TRUNCATE") return "truncate";
  if (changesPrivileges(code)) return "grant";
  const shape = analyzeQuery(sql, type).type;
  if (shape !== "DELETE" && shape !== "UPDATE") return null;
  // A DELETE waits whether or not it carries a WHERE. The WHERE test asks only
  // whether the word is present, and a predicate that is always true satisfies it:
  // `DELETE FROM t WHERE 1=1` emptied a table here with no reviewer. Rather than
  // chase trivially-true predicates - `1=1`, `true`, `'a'='a'`, and whatever is
  // written next - every DELETE is held and a person reads the statement.
  //
  // UPDATE keeps the narrower rule: it has the same hole (`UPDATE t SET c = 1 WHERE 1=1`
  // rewrote every row), but holding every UPDATE would queue the ordinary single-row
  // edit this route exists to serve. Named in docs/CONTEXT.md §4.15 as the open half.
  if (shape === "DELETE") return /\bWHERE\b/i.test(code) ? "delete" : "delete_without_where";
  if (!/\bWHERE\b/i.test(code)) return "update_without_where";
  return alwaysTrueWhere(code) ? "update_always_true" : null;
}

/** The first guardrail any of the statements trips, or null. */
export function firstGuardrail(statements: readonly string[], type?: DatabaseType): Guardrail | null {
  for (const sql of statements) {
    const found = dangerOf(sql, type);
    if (found) return found;
  }
  return null;
}
