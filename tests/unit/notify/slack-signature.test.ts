import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { SLACK_SIGNATURE_WINDOW_S, verifySlackSignature } from "@/lib/notify/slack-signature";

/**
 * Slack's signature (docs/CONTEXT.md §4.24): the HMAC over version, timestamp and raw body,
 * a five-minute window against replay, and nothing verifies without a secret or a header.
 */
const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = (ts: string, body: string) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
const now = 1_726_000_000_000;

describe("verifySlackSignature", () => {
  test("a signature over the exact body and timestamp verifies inside the window", () => {
    const ts = String(Math.floor(now / 1000) - 10);
    expect(
      verifySlackSignature({
        body: "payload=%7B%7D",
        timestamp: ts,
        signature: sign(ts, "payload=%7B%7D"),
        secret,
        now,
      }),
    ).toBe(true);
  });

  test("a changed body, a wrong secret, a stale timestamp, a malformed one, or a missing header does not", () => {
    const ts = String(Math.floor(now / 1000));
    const good = sign(ts, "a=1");
    expect(verifySlackSignature({ body: "a=2", timestamp: ts, signature: good, secret, now })).toBe(false);
    expect(verifySlackSignature({ body: "a=1", timestamp: ts, signature: good, secret: "other", now })).toBe(false);
    const stale = String(Math.floor(now / 1000) - SLACK_SIGNATURE_WINDOW_S - 1);
    expect(verifySlackSignature({ body: "a=1", timestamp: stale, signature: sign(stale, "a=1"), secret, now })).toBe(
      false,
    );
    expect(verifySlackSignature({ body: "a=1", timestamp: "yesterday", signature: good, secret, now })).toBe(false);
    expect(verifySlackSignature({ body: "a=1", timestamp: null, signature: good, secret, now })).toBe(false);
    expect(verifySlackSignature({ body: "a=1", timestamp: ts, signature: null, secret, now })).toBe(false);
    expect(verifySlackSignature({ body: "a=1", timestamp: ts, signature: good, secret: "", now })).toBe(false);
    expect(verifySlackSignature({ body: "a=1", timestamp: ts, signature: "v0=short", secret, now })).toBe(false);
  });
});
