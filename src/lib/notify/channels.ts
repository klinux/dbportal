import { logger } from "@/lib/logger";
import type { Channel } from "@/lib/channels/store";
import { callbackSecret, signCallback } from "./callback";
import { postSlackMessage } from "./slack";

/**
 * Delivery to a notification channel (docs/CONTEXT.md §4.29). One shape of message, four
 * receivers: the Slack bot; a generic webhook that gets the message as JSON, signed with
 * CALLBACK_SIGNING_SECRET when the operator set one (headers as §4.25); a Grafana OnCall
 * formatted webhook; a Rootly alert source. Best effort, two attempts, one warning: an
 * unreachable receiver never fails the alert run that produced the message.
 */
export interface AlertMessage {
  alertId: string;
  alertName: string;
  datasourceName: string;
  state: "firing" | "resolved" | "test";
  /** What the query returned, as text; absent for a test. */
  value?: string;
  /** The condition as the alert states it, e.g. `count > 100`. */
  condition: string;
  at: string;
  /** Where the alert is read in the portal, when APP_URL is set. */
  url?: string;
}

export const DELIVERY_ATTEMPT_DELAYS_MS = [0, 2_000];
const ATTEMPT_TIMEOUT_MS = 10_000;

function title(m: AlertMessage): string {
  const state = m.state === "firing" ? "FIRING" : m.state === "resolved" ? "resolved" : "test";
  return `[${state}] ${m.alertName} on ${m.datasourceName}`;
}

function summary(m: AlertMessage): string {
  const value = m.value === undefined ? "" : ` Value: ${m.value}.`;
  return `${m.condition}.${value}${m.url ? ` ${m.url}` : ""}`;
}

/** The body each receiver kind expects. */
export function payloadFor(kind: Channel["kind"], m: AlertMessage): Record<string, unknown> {
  switch (kind) {
    case "oncall":
      // Grafana OnCall "formatted webhook": alert_uid groups firing and resolved into one alert group.
      return {
        alert_uid: `dbportal-alert-${m.alertId}`,
        title: title(m),
        state: m.state === "firing" ? "alerting" : "ok",
        message: summary(m),
        ...(m.url ? { link_to_upstream_details: m.url } : {}),
      };
    case "rootly":
      return {
        summary: title(m),
        description: summary(m),
        status: m.state === "firing" ? "triggered" : "resolved",
        external_id: `dbportal-alert-${m.alertId}`,
        alert: m.alertName,
        datasource: m.datasourceName,
        ...(m.value !== undefined ? { value: m.value } : {}),
        ...(m.url ? { url: m.url } : {}),
        at: m.at,
      };
    default:
      return { event: `alert.${m.state}`, title: title(m), ...m };
  }
}

async function postJson(channel: Channel, m: AlertMessage, delays: readonly number[]): Promise<boolean> {
  const body = JSON.stringify(payloadFor(channel.kind, m));
  const secret = callbackSecret();
  for (let attempt = 0; attempt < DELIVERY_ATTEMPT_DELAYS_MS.length; attempt++) {
    if (DELIVERY_ATTEMPT_DELAYS_MS[attempt] > 0)
      await new Promise((r) => setTimeout(r, DELIVERY_ATTEMPT_DELAYS_MS[attempt]));
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(channel.target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Dbportal-Event": `alert.${m.state}`,
          "X-Dbportal-Timestamp": timestamp,
          ...(secret ? { "X-Dbportal-Signature": signCallback(body, timestamp, secret) } : {}),
          "X-Dbportal-Delivery": `${m.alertId}:${attempt + 1}`,
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) return true;
      // The receiver's own answer will not change on retry; a 5xx may.
      if (res.status < 500) {
        logger.warn("Alert delivery refused by the receiver", { channel: channel.id, status: res.status });
        return false;
      }
    } catch (error) {
      logger.debug("Alert delivery attempt failed", {
        channel: channel.id,
        attempt: attempt + 1,
        error: (error as Error).name,
      });
    }
  }
  logger.warn("Alert not delivered", { channel: channel.id, attempts: delays.length });
  return false;
}

/** Deliver one message to one channel; true when the receiver took it. */
export async function deliverToChannel(
  channel: Channel,
  message: AlertMessage,
  delays: readonly number[] = DELIVERY_ATTEMPT_DELAYS_MS,
): Promise<boolean> {
  if (channel.kind === "slack") {
    return postSlackMessage({ channel: channel.target, text: `*${title(message)}*\n${summary(message)}` });
  }
  return postJson(channel, message, delays);
}
