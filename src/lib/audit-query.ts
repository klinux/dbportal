import type { AuditEvent } from "@/lib/audit";
import type { AuditEventQuery } from "@/lib/storage/types";

/**
 * The admin Audit page's question (docs/CONTEXT.md §4.27): which events, of whom, on which
 * datasource, in which period, how many and from where. Read once from the query string
 * here, answered by the store with SQL, or by the ring buffer with `matchesAuditQuery` -
 * the same question either way.
 */
export const AUDIT_PAGE_MAX = 500;
export const AUDIT_PAGE_DEFAULT = 100;
const TEXT_MAX = 254;

export function readAuditQuery(params: URLSearchParams): { query: AuditEventQuery } | { error: string } {
  const text = (name: string) => {
    const value = params.get(name)?.trim() ?? "";
    return value.length > 0 ? value.slice(0, TEXT_MAX) : undefined;
  };
  const instant = (name: string) => {
    const value = text(name);
    if (value === undefined) return { ok: true as const, value: undefined };
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { ok: true as const, value: new Date(ms).toISOString() } : { ok: false as const };
  };
  const from = instant("from");
  const to = instant("to");
  if (!from.ok || !to.ok) return { error: "from and to must be dates" };
  if (from.value && to.value && from.value > to.value) return { error: "from must not be after to" };
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const limit = limitRaw === null ? AUDIT_PAGE_DEFAULT : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) {
    return { error: `limit must be an integer between 1 and ${AUDIT_PAGE_MAX}` };
  }
  if (!Number.isInteger(offset) || offset < 0) return { error: "offset must be a non-negative integer" };
  const result = text("result");
  if (result !== undefined && result !== "success" && result !== "failure") {
    return { error: 'result must be "success" or "failure"' };
  }
  return {
    query: {
      ...(text("type") ? { type: text("type") } : {}),
      ...(text("actor") ? { actor: text("actor") } : {}),
      ...(text("connection") ? { connectionName: text("connection") } : {}),
      ...(result ? { result } : {}),
      ...(from.value ? { from: from.value } : {}),
      ...(to.value ? { to: to.value } : {}),
      limit,
      offset,
    },
  };
}

/** The same question asked of one event, for the ring buffer. */
export function matchesAuditQuery(event: AuditEvent, query: Omit<AuditEventQuery, "limit" | "offset">): boolean {
  if (query.type && event.type !== query.type) return false;
  if (query.actor && event.user !== query.actor) return false;
  if (query.connectionName && event.connectionName !== query.connectionName) return false;
  if (query.result && event.result !== query.result) return false;
  if (query.from && event.timestamp < query.from) return false;
  if (query.to && event.timestamp > query.to) return false;
  return true;
}
