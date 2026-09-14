import { createHmac } from "node:crypto";
import { logger } from "@/lib/logger";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The signed callback (docs/CONTEXT.md §4.25): a bot outside Slack names an HTTPS URL with
 * its request, and when the request is decided or has run, the outcome is POSTed there as
 * JSON with an HMAC the bot verifies - so it need not poll, and cannot be fooled by anyone
 * who knows the URL. Where a callback may go is the operator's list (`CALLBACK_ALLOWED_HOSTS`),
 * because a URL a token supplies is a request this server makes on the token's word: no
 * list, no callbacks. Three attempts, then one warning; nothing here fails the request.
 */
export const CALLBACK_SIGNATURE_VERSION = "v1";
export const CALLBACK_ATTEMPT_DELAYS_MS = [0, 2_000, 10_000];
const ATTEMPT_TIMEOUT_MS = 10_000;
const URL_MAX = 512;

export function callbackSecret(): string {
  return process.env.CALLBACK_SIGNING_SECRET ?? "";
}

export function allowedCallbackHosts(): Set<string> {
  return new Set(
    (process.env.CALLBACK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The URL as a bot may name it, or the reason it may not. */
export function readCallbackUrl(value: unknown): { url: string } | { error: string } {
  if (typeof value !== "string" || value.length === 0 || value.length > URL_MAX) {
    return { error: "callback.url must be a string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "callback.url must be an absolute URL" };
  }
  if (parsed.protocol !== "https:") return { error: "callback.url must be https" };
  if (parsed.username || parsed.password) return { error: "callback.url may not carry credentials" };
  if (!callbackSecret()) return { error: "Callbacks are not enabled on this server (CALLBACK_SIGNING_SECRET)" };
  if (!allowedCallbackHosts().has(parsed.hostname.toLowerCase())) {
    return { error: `callback.url host "${parsed.hostname}" is not in CALLBACK_ALLOWED_HOSTS` };
  }
  return { url: parsed.toString() };
}

/** `v1=` HMAC-SHA256 of `<timestamp>.<body>`; the bot recomputes it with the shared secret. */
export function signCallback(body: string, timestamp: string, secret: string): string {
  return `${CALLBACK_SIGNATURE_VERSION}=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** What the bot receives: the record's outcome and nothing the portal would not show it on GET. */
export function callbackPayload(record: ApprovalRequest): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    datasourceId: record.datasourceId,
    datasourceName: record.datasourceName,
    subject: record.subject,
    requestedAt: record.requestedAt,
    ...(record.ticket ? { ticket: record.ticket } : {}),
    ...(record.reviewer ? { reviewer: record.reviewer, reviewedAt: record.reviewedAt } : {}),
    ...(record.note ? { note: record.note } : {}),
    ...(record.execution ? { execution: record.execution } : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The delivery, attempt by attempt; true once one attempt was accepted. */
export async function notifyCallback(record: ApprovalRequest, delays = CALLBACK_ATTEMPT_DELAYS_MS): Promise<boolean> {
  const url = record.callback?.url;
  const secret = callbackSecret();
  if (!url || !secret) return false;
  const body = JSON.stringify(callbackPayload(record));
  const event = `execution.${record.execution?.status ?? record.status}`;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Dbportal-Event": event,
          "X-Dbportal-Timestamp": timestamp,
          "X-Dbportal-Signature": signCallback(body, timestamp, secret),
          "X-Dbportal-Delivery": `${record.id}:${attempt + 1}`,
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) return true;
      // A 4xx is the bot's answer and will not change on retry; a 5xx may.
      if (res.status < 500) {
        logger.warn("Callback refused by the receiver", { approvalId: record.id, status: res.status });
        return false;
      }
    } catch (error) {
      logger.debug("Callback attempt failed", {
        approvalId: record.id,
        attempt: attempt + 1,
        error: (error as Error).name,
      });
    }
  }
  logger.warn("Callback not delivered", { approvalId: record.id, attempts: delays.length });
  return false;
}
