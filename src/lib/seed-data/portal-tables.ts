/**
 * The portal's own store tables (src/lib/storage/providers): never part of a seed plan. A
 * datasource may point at the database that hosts the store - a local install does - and a
 * plan that listed them would fill them with generated rows or, with `truncate`, empty
 * them (measured 2026-09-14 on a local install: the store went with the tables). Its own
 * module because both catalog readers need it and neither should load the other.
 */
export const PORTAL_TABLES: ReadonlySet<string> = new Set([
  "user_storage",
  "audit_events",
  "approval_requests",
  "jobs",
  "leases",
]);

/** The store's tables, the audit record's partitions included (§4.43: `audit_events_p2026_09`, `audit_events_legacy`). */
export function isPortalTable(name: string): boolean {
  return PORTAL_TABLES.has(name) || name.startsWith("audit_events_");
}
