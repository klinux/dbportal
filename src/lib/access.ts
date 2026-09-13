import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { readsSqlText } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";

/**
 * Who may open a datasource, and who may write to it (docs/CONTEXT.md §4.4).
 *
 * The model is two lists on the datasource and one list on the session, deliberately no
 * more than that:
 *
 * - A session's PRINCIPALS: `*`, its role (`admin` | `user`) and one `group:<name>` per
 *   group the identity provider put in its token. Local accounts have no groups.
 * - A datasource's `roles`: the principals that may OPEN it (the list the seed YAML always
 *   had, now accepting `group:<name>` too).
 * - A datasource's `writeRoles`: the principals that may run a WRITE. Absent means everyone
 *   who can open may write (what every datasource did before this existed); `[]` means
 *   nobody - a read-only datasource for everyone, administrators included, because the
 *   portal's admin role is about the portal, not about the database.
 *
 * Both checks are pure functions over the token and the resolved datasource: no store is
 * consulted per request, which is what keeps them free.
 */

export interface AccessSession {
  role: string;
  groups?: string[];
}

export interface AccessRules {
  roles: string[];
  writeRoles?: string[];
}

export const GROUP_PRINCIPAL_PREFIX = "group:";

/** Bounds on what a token may carry: a JWT travels in a cookie on every request. */
export const MAX_GROUPS = 50;
export const MAX_GROUP_LENGTH = 64;

/**
 * The group names a token may carry, from whatever the identity provider sent: strings
 * only, printable, bounded in count and length, deduplicated. Order is preserved because
 * the operator reads them back in the admin view.
 */
export function normalizeGroups(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const groups: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const cleaned = entry
      .replace(/[^\x20-\x7e]/g, "")
      .trim()
      .slice(0, MAX_GROUP_LENGTH);
    if (cleaned.length === 0 || groups.includes(cleaned)) continue;
    groups.push(cleaned);
    if (groups.length === MAX_GROUPS) break;
  }
  return groups;
}

export function principalsOf(session: AccessSession): string[] {
  return ["*", session.role, ...(session.groups ?? []).map((group) => `${GROUP_PRINCIPAL_PREFIX}${group}`)];
}

export function matchesAccess(rule: readonly string[], principals: readonly string[]): boolean {
  return rule.some((entry) => principals.includes(entry));
}

export function canWrite(rules: AccessRules, session: AccessSession): boolean {
  if (rules.writeRoles === undefined) return true;
  return matchesAccess(rules.writeRoles, principalsOf(session));
}

/**
 * Whether a statement only reads, as far as a read-only rule is concerned.
 *
 * Read: a SELECT (a `WITH` whose CTE list the shared classifier types as a read counts),
 * `SHOW` / `DESCRIBE` / `DESC`, and an `EXPLAIN` of a read. `EXPLAIN ANALYZE UPDATE ...`
 * RUNS the update, which is why the statement under the EXPLAIN is what gets classified,
 * not the EXPLAIN itself.
 *
 * Unknown is a write. An engine whose statements are not SQL text (MongoDB, Redis, the
 * search engines) has nothing this reader can classify, so a read-only rule on such a
 * datasource refuses every execution - a rule that cannot be enforced must not be
 * reported as enforced.
 *
 * This is a POLICY gate, evaluated from the current rules on every request. It is not a
 * sandbox: a SELECT can call a function with side effects. Where the engine can enforce
 * read-only itself, the provider is opened that way too (PostgreSQL:
 * `default_transaction_read_only`, see src/lib/db/factory.ts), and that is the layer a
 * SELECT with side effects meets.
 */
export function isReadStatement(sql: string, type?: DatabaseType): boolean {
  if (!readsSqlText(type)) return false;
  const explained = stripExplain(sql);
  if (explained !== null) return isReadStatement(explained, type);
  if (/^\s*(show|describe|desc)\b/i.test(stripLeadingComments(sql))) return true;
  return analyzeQuery(sql, type).type === "SELECT";
}

function stripLeadingComments(sql: string): string {
  let out = sql;
  for (;;) {
    const next = out.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)/, "");
    if (next === out) return out.trimStart();
    out = next;
  }
}

/** The statement under an EXPLAIN, or null when the statement is not one. */
function stripExplain(sql: string): string | null {
  const body = stripLeadingComments(sql);
  const match = body.match(
    /^explain\b(\s*\([^)]*\))?((\s+(analyze|analyse|verbose|costs|buffers|extended|partitions))|(\s+format\s*=?\s*\w+))*\s*/i,
  );
  if (!match) return null;
  const rest = body.slice(match[0].length);
  return rest.length > 0 ? rest : null;
}
