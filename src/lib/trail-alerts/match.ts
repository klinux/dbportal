import type { AuditEvent } from "@/lib/audit";
import { PRODUCTION_ENVIRONMENT } from "@/lib/types";
import type { TrailAlertsConfig, TrailRule } from "./store";

/**
 * Which rule an audit event trips (docs/CONTEXT.md §4.32), from the event alone plus the
 * environment of the datasource it names: a guardrail is the denial the write gate records
 * with that reason; a large export is a successful `data_export` of at least the threshold's
 * rows from a production datasource; a backup or a seed that failed says so in its result.
 * Pure, so the observer's own lines (type `alert`) and everything else fall through.
 */
export function ruleFor(
  event: Pick<AuditEvent, "type" | "action" | "result" | "reason" | "rows" | "connectionName">,
  config: Pick<TrailAlertsConfig, "exportRowsThreshold">,
  environmentOf: (connectionName: string) => string | undefined,
): TrailRule | null {
  if (event.type === "permission_denied" && event.reason === "guardrail") return "guardrail";
  if (event.type === "data_export" && event.result === "success") {
    const rows = event.rows ?? 0;
    const environment = event.connectionName ? environmentOf(event.connectionName) : undefined;
    return rows >= config.exportRowsThreshold && environment === PRODUCTION_ENVIRONMENT ? "production_export" : null;
  }
  if (event.type === "backup" && event.result === "failure") return "backup_failed";
  if (event.type === "data_seed" && event.action === "failed") return "seed_failed";
  return null;
}

/** What the message says of the event, without anything the trail itself would not show. */
export function describeTrailEvent(
  rule: TrailRule,
  event: Pick<AuditEvent, "action" | "user" | "target" | "rows">,
): string {
  switch (rule) {
    case "guardrail":
      return `${event.user} was stopped by a guardrail on ${event.target}`;
    case "production_export":
      return `${event.user} exported ${event.rows ?? 0} rows as ${event.action}`;
    case "backup_failed":
      return `backup ${event.action} by ${event.user} failed`;
    default:
      return `seed run by ${event.user} failed`;
  }
}
