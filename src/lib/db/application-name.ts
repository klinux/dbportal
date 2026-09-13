/**
 * The session label a person's pool carries into the engine (docs/CONTEXT.md §4.3).
 *
 * Every datasource opens under one shared database role, so the engine's own views -
 * `pg_stat_activity`, pgAudit, `sys.dm_exec_sessions`, `performance_schema` - name the
 * role and not the person. Giving each person's pool its own application name puts the
 * person back into those views, which is a second audit trail that dbportal does not
 * write and cannot lose: the database keeps it.
 *
 * Bounded to 63 characters because PostgreSQL truncates `application_name` at
 * NAMEDATALEN - 1 and truncation would cut the suffix that says where the session came
 * from; ASCII only because PostgreSQL replaces anything else with `?` and the other
 * engines are no friendlier. The username goes first so a long one loses its tail, not
 * the marker.
 */
export const APPLICATION_NAME_SUFFIX = "@dbportal";
export const APPLICATION_NAME_MAX_LENGTH = 63;

export function applicationNameFor(username: string): string {
  const printable = username.replace(/[^\x20-\x7e]/g, "?").trim();
  const room = APPLICATION_NAME_MAX_LENGTH - APPLICATION_NAME_SUFFIX.length;
  return `${printable.slice(0, room)}${APPLICATION_NAME_SUFFIX}`;
}
