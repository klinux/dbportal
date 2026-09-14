import { emitAuditEvent, setAuditObserver, type AuditEvent } from "@/lib/audit";
import { findChannel } from "@/lib/channels/store";
import { listSharedDatasources } from "@/lib/datasources/store";
import { logger } from "@/lib/logger";
import { deliverToChannel } from "@/lib/notify/channels";
import { loadConfig } from "@/lib/seed/config-loader";
import { describeTrailEvent, ruleFor } from "./match";
import { getTrailAlerts, TRAIL_RULE_LABELS, type TrailRule } from "./store";

/**
 * The observer on the audit channel (docs/CONTEXT.md §4.32): every event passes through
 * `ruleFor`; one that trips a rule with channels named is delivered to them, once per rule
 * and datasource per cooldown, so a guardrail hit in a loop pages once. The datasource's
 * environment is read off the seed file and the store, kept a minute. A delivery the
 * receiver refused is an `alert delivery_failed` line; the observer's own lines never trip
 * a rule, so there is no loop.
 */
export const TRAIL_COOLDOWN_MS = 5 * 60_000;
const ENVIRONMENTS_TTL_MS = 60_000;

const KEY = Symbol.for("dbportal.trail-alerts");
interface State {
  lastSent: Map<string, number>;
  environments: { at: number; byName: Map<string, string | undefined> } | null;
}
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  g[KEY] ??= { lastSent: new Map(), environments: null };
  return g[KEY];
}

/** Tests only. */
export function resetTrailAlertsState(): void {
  delete (globalThis as typeof globalThis & { [KEY]?: State })[KEY];
}

async function environmentsByName(now: number): Promise<Map<string, string | undefined>> {
  const s = state();
  if (s.environments && now - s.environments.at < ENVIRONMENTS_TTL_MS) return s.environments.byName;
  const byName = new Map<string, string | undefined>();
  const config = await loadConfig().catch(() => null);
  for (const conn of config?.connections ?? []) byName.set(conn.name, conn.environment);
  for (const conn of await listSharedDatasources().catch(() => [])) byName.set(conn.name, conn.environment);
  s.environments = { at: now, byName };
  return byName;
}

export async function observeForTrailAlerts(event: AuditEvent, now = Date.now()): Promise<TrailRule | null> {
  if (event.type === "alert") return null;
  const config = await getTrailAlerts();
  const environments = await environmentsByName(now);
  const rule = ruleFor(event, config, (name) => environments.get(name));
  if (!rule || config.rules[rule].length === 0) return null;
  const key = `${rule}:${event.connectionName ?? ""}`;
  const last = state().lastSent.get(key);
  if (last !== undefined && now - last < TRAIL_COOLDOWN_MS) return null;
  state().lastSent.set(key, now);
  const message = {
    alertId: `trail-${rule}`,
    alertName: TRAIL_RULE_LABELS[rule],
    datasourceName: event.connectionName ?? "dbportal",
    state: "firing" as const,
    value: describeTrailEvent(rule, event),
    condition: TRAIL_RULE_LABELS[rule],
    at: event.timestamp,
  };
  for (const id of config.rules[rule]) {
    const channel = await findChannel(id);
    const delivered = channel ? await deliverToChannel(channel, message) : false;
    if (!delivered) {
      emitAuditEvent({
        type: "alert",
        action: "delivery_failed",
        target: `trail-${rule}`,
        user: "system",
        result: "failure",
        details: channel ? `channel ${id}` : `channel ${id} not declared`,
      });
    }
  }
  return rule;
}

export function registerTrailAlerts(): void {
  setAuditObserver(async (event) => {
    try {
      await observeForTrailAlerts(event);
    } catch (error) {
      logger.error("Trail alert observer failed", error, { route: "trail-alerts", eventId: event.id });
    }
  });
}
