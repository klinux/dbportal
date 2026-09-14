import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { createHmac } from "node:crypto";

/**
 * Delivery to a channel (docs/CONTEXT.md §4.29): one message, the body each receiver kind
 * expects, the signature when the operator set the secret, a 4xx that ends it, a 5xx that
 * is tried once more, a network failure that is not the alert's failure. The receiver is a
 * fetch spy; Slack goes through the bot's own poster.
 */
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, debug: () => {}, info: () => {}, error: () => {} } }));
const { deliverToChannel, payloadFor } = await import("@/lib/notify/channels");

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
const saved: Record<string, string | undefined> = {};
const message = {
  alertId: "slow-orders",
  alertName: "Slow orders",
  datasourceName: "Orders",
  state: "firing" as const,
  value: "120",
  condition: "count > 100",
  at: "2026-09-14T00:00:00.000Z",
  url: "https://portal.example.test/alerts",
};
const webhook = { id: "hook", name: "Hook", kind: "webhook" as const, target: "https://h.test/x" };
const sentBody = (i = 0) => JSON.parse(String((fetchSpy.mock.calls[i] as [string, RequestInit])[1].body));
const sentHeaders = (i = 0) => (fetchSpy.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>;

describe("notify/channels", () => {
  beforeEach(() => {
    for (const k of ["CALLBACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fetchSpy = spyOn(holder, "fetch");
    warn.mockClear();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("each receiver kind gets the body it expects", () => {
    expect(payloadFor("oncall", message)).toEqual({
      alert_uid: "dbportal-alert-slow-orders",
      title: "[FIRING] Slow orders on Orders",
      state: "alerting",
      message: "count > 100. Value: 120. https://portal.example.test/alerts",
      link_to_upstream_details: "https://portal.example.test/alerts",
    });
    expect(payloadFor("oncall", { ...message, state: "resolved", url: undefined, value: undefined })).toMatchObject({
      state: "ok",
      title: "[resolved] Slow orders on Orders",
      message: "count > 100.",
    });
    expect(payloadFor("rootly", message)).toMatchObject({
      summary: "[FIRING] Slow orders on Orders",
      status: "triggered",
      external_id: "dbportal-alert-slow-orders",
      value: "120",
      url: message.url,
    });
    expect(payloadFor("rootly", { ...message, state: "resolved" }).status).toBe("resolved");
    expect(payloadFor("webhook", message)).toMatchObject({
      event: "alert.firing",
      alertId: "slow-orders",
      value: "120",
    });
    expect(payloadFor("webhook", { ...message, state: "test" }).title).toBe("[test] Slow orders on Orders");
  });

  test("a webhook is POSTed with the delivery headers, signed when the secret is set, and a 4xx ends it", async () => {
    fetchSpy.mockImplementation(async () => new Response("ok", { status: 200 }));
    expect(await deliverToChannel(webhook, message, [0])).toBe(true);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://h.test/x");
    expect(sentHeaders()["X-Dbportal-Event"]).toBe("alert.firing");
    expect(sentHeaders()["X-Dbportal-Delivery"]).toBe("slow-orders:1");
    expect(sentHeaders()["X-Dbportal-Signature"]).toBeUndefined();
    expect(sentBody()).toMatchObject({ event: "alert.firing" });

    process.env.CALLBACK_SIGNING_SECRET = "shh";
    await deliverToChannel(webhook, message, [0]);
    const headers = sentHeaders(1);
    const expected = `v1=${createHmac("sha256", "shh")
      .update(`${headers["X-Dbportal-Timestamp"]}.${String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body)}`)
      .digest("hex")}`;
    expect(headers["X-Dbportal-Signature"]).toBe(expected);

    fetchSpy.mockImplementation(async () => new Response("no", { status: 403 }));
    expect(await deliverToChannel(webhook, message, [0, 0])).toBe(false);
    expect(fetchSpy.mock.calls).toHaveLength(3);
    expect(warn).toHaveBeenLastCalledWith("Alert delivery refused by the receiver", { channel: "hook", status: 403 });
  });

  test("a 5xx and a network failure are tried again per the delays, then given up on with one warning", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    fetchSpy.mockImplementationOnce(async () => Promise.reject(new TypeError("connect")));
    expect(await deliverToChannel({ ...webhook, kind: "rootly" }, message, [0, 0])).toBe(false);
    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(sentHeaders(1)["X-Dbportal-Delivery"]).toBe("slow-orders:2");
    expect(warn).toHaveBeenLastCalledWith("Alert not delivered", { channel: "hook", attempts: 2 });
  });

  test("a Slack channel goes through the bot: nothing without the token, the message as text with it", async () => {
    const slack = { id: "ops", name: "Ops", kind: "slack" as const, target: "C0123" };
    expect(await deliverToChannel(slack, message)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await deliverToChannel(slack, message)).toBe(true);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(sentBody()).toEqual({
      channel: "C0123",
      text: "*[FIRING] Slow orders on Orders*\ncount > 100. Value: 120. https://portal.example.test/alerts",
    });
  });
});
