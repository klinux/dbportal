import { isReadStatement } from "@/lib/access";
import { assertObjectsAllowed } from "@/lib/api/object-gate";
import { emitAuditEvent } from "@/lib/audit";
import { auditExecution, executionFailureReason } from "@/lib/audit-execution";
import { findChannel } from "@/lib/channels/store";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { capPrepareOptions, withConcurrency } from "@/lib/limits";
import { logger } from "@/lib/logger";
import { deliverToChannel, type AlertMessage } from "@/lib/notify/channels";
import { withNamedRoles } from "@/lib/roles/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { describeCondition, evaluate } from "./evaluate";
import { type AlertRecord, type AlertState, updateAlertState } from "./store";

/**
 * One run of one alert (docs/CONTEXT.md §4.29): open the datasource as the owner's
 * snapshot would, run the read bounded to a few rows, evaluate, move the state, and tell
 * the channels what changed - firing when the condition starts to hold, again after the
 * cooldown while it keeps holding, resolved when it stops. A read that fails leaves the
 * alert in `error` with the audit reason and pages nobody: a broken query is a thing to
 * fix, not an incident. The audit line of the read is the ordinary `query_execution`,
 * action `alert`, under the owner.
 */
export const ALERT_MAX_ROWS = 100;
export const ALERT_ROUTE = "alert";

function appUrl(path: string): string | undefined {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}${path}` : undefined;
}

async function announce(record: AlertRecord, message: AlertMessage): Promise<void> {
  for (const id of record.channels) {
    const channel = await findChannel(id);
    const delivered = channel ? await deliverToChannel(channel, message) : false;
    if (!delivered) {
      emitAuditEvent({
        type: "alert",
        action: "delivery_failed",
        target: record.id,
        user: record.owner.username,
        result: "failure",
        details: channel ? `channel ${id}` : `channel ${id} not declared`,
      });
    }
  }
}

/** The next state and what to tell the channels, from the outcome of a run. */
export function transition(
  previous: AlertState,
  outcome: { holds: boolean; value: string | undefined },
  cooldownMinutes: number,
  now: Date,
): { state: AlertState; notify: "firing" | "resolved" | null } {
  const at = now.toISOString();
  const base: AlertState = { ...previous, lastRunAt: at, lastValue: outcome.value, lastError: undefined };
  if (outcome.holds) {
    const wasFiring = previous.status === "firing";
    const since = previous.lastNotifiedAt ? now.getTime() - Date.parse(previous.lastNotifiedAt) : Infinity;
    const again = wasFiring && since >= cooldownMinutes * 60_000;
    const notify = !wasFiring || again;
    return {
      state: {
        ...base,
        status: "firing",
        lastFiredAt: wasFiring ? previous.lastFiredAt : at,
        ...(notify ? { lastNotifiedAt: at } : {}),
      },
      notify: notify ? "firing" : null,
    };
  }
  return {
    state: { ...base, status: "ok" },
    notify: previous.status === "firing" ? "resolved" : null,
  };
}

export async function runAlert(record: AlertRecord, now = new Date()): Promise<AlertState> {
  const owner = await withNamedRoles({ ...record.owner });
  let state: AlertState;
  let notify: "firing" | "resolved" | null = null;
  try {
    const connection = await resolveConnection({ connectionId: `seed:${record.datasource}` }, owner);
    if (!isReadStatement(record.sql, connection.type)) throw new AlertStatementError();
    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(owner.username),
      readOnly: true,
    });
    // The owner's object rules (docs/CONTEXT.md §4.56): an alert reads only what its owner may.
    await assertObjectsAllowed({ route: ALERT_ROUTE, session: owner, connection, statements: [record.sql], provider });
    const prepared = provider.prepareQuery(record.sql, capPrepareOptions({ limit: ALERT_MAX_ROWS }, connection.limits));
    const result = await withConcurrency(connection, owner.username, () =>
      auditExecution(
        {
          route: ALERT_ROUTE,
          action: "alert",
          user: owner.username,
          connectionName: connection.name,
          statement: prepared.query,
        },
        () => provider.query(prepared.query),
      ),
    );
    const outcome = evaluate(record, result, record.state.lastValue);
    ({ state, notify } = transition(record.state, outcome, record.cooldownMinutes, now));
    if (notify) {
      emitAuditEvent({
        type: "alert",
        action: notify === "firing" ? "fired" : "resolved",
        target: record.id,
        user: owner.username,
        result: "success",
        connectionName: connection.name,
        details: `${describeCondition(record)}${outcome.value !== undefined ? `; value ${outcome.value}` : ""}`.slice(
          0,
          200,
        ),
      });
      await announce(record, {
        alertId: record.id,
        alertName: record.name,
        datasourceName: connection.name,
        state: notify,
        value: outcome.value,
        condition: describeCondition(record),
        at: now.toISOString(),
        url: appUrl("/alerts"),
      });
    }
  } catch (error) {
    const reason =
      error instanceof AlertStatementError
        ? "not_a_read"
        : (error as { statusCode?: number }).statusCode === 403 || (error as { statusCode?: number }).statusCode === 404
          ? "access"
          : executionFailureReason(error);
    logger.warn("Alert run failed", { route: ALERT_ROUTE, alertId: record.id, reason });
    state = { ...record.state, status: "error", lastRunAt: now.toISOString(), lastError: reason };
  }
  await updateAlertState(record.id, state);
  return state;
}

class AlertStatementError extends Error {
  constructor() {
    super("Only a statement that reads may be an alert");
    this.name = "AlertStatementError";
  }
}
