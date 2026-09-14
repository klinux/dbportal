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
 *
 * Named roles (docs/CONTEXT.md §4.19) add one principal per role the session is in,
 * `role:<id>`, resolved once when the session is read (src/lib/roles/store.ts) from a
 * cached list; the checks here stay pure over the session they are handed.
 */

export interface AccessSession {
  role: string;
  username?: string;
  groups?: string[];
  /** Ids of the named roles this session is in, resolved when the session was read (§4.19). */
  namedRoles?: string[];
}

export interface AccessRules {
  roles: string[];
  writeRoles?: string[];
}

/** Who may take a result out as a file (docs/CONTEXT.md §4.22). */
export interface ExportRules {
  environment?: string;
  exportRoles?: string[];
}

export const GROUP_PRINCIPAL_PREFIX = "group:";
export const ROLE_PRINCIPAL_PREFIX = "role:";
export const USER_PRINCIPAL_PREFIX = "user:";

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
  return [
    "*",
    session.role,
    ...(session.groups ?? []).map((group) => `${GROUP_PRINCIPAL_PREFIX}${group}`),
    ...(session.namedRoles ?? []).map((id) => `${ROLE_PRINCIPAL_PREFIX}${id}`),
  ];
}

/**
 * What a named role's member list is matched against (§4.19): the session's role, its
 * groups, and the person by username - never the named roles themselves, so a role
 * cannot be a member of a role.
 */
export function memberPrincipalsOf(session: AccessSession): string[] {
  return [
    session.role,
    ...(session.groups ?? []).map((group) => `${GROUP_PRINCIPAL_PREFIX}${group}`),
    ...(session.username ? [`${USER_PRINCIPAL_PREFIX}${session.username}`] : []),
  ];
}

export function matchesAccess(rule: readonly string[], principals: readonly string[]): boolean {
  return rule.some((entry) => principals.includes(entry));
}

/** Who may review a write on this datasource: its `approverRoles`, or administrators. */
export function canApprove(rules: { approverRoles?: readonly string[] }, session: AccessSession): boolean {
  return matchesAccess(rules.approverRoles ?? ["admin"], principalsOf(session));
}

/**
 * Whether this session may export a result of the datasource (§4.22): the datasource's
 * `exportRoles` when it declares them (`[]` is nobody); otherwise everyone who can open it,
 * except on production, where nothing leaves as a file until somebody says who may take it.
 */
export function canExport(rules: ExportRules, session: AccessSession): boolean {
  if (rules.exportRoles !== undefined) return matchesAccess(rules.exportRoles, principalsOf(session));
  return rules.environment !== "production";
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
