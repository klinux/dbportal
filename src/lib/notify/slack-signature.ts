import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack's request signature (docs/CONTEXT.md §4.24): `v0=` HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>` under the app's signing secret, and a timestamp no older than
 * five minutes so a captured request cannot be replayed later. Compared in constant time.
 */
export const SLACK_SIGNATURE_WINDOW_S = 5 * 60;

export function verifySlackSignature(input: {
  body: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now?: number;
}): boolean {
  const { body, timestamp, signature, secret } = input;
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_SIGNATURE_WINDOW_S) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
