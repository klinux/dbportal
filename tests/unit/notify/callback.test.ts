import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The signed callback (docs/CONTEXT.md §4.25): a URL only where the operator allows one,
 * HTTPS and bare of credentials; the outcome POSTed with an HMAC the bot can recompute;
 * three attempts on a network failure or a 5xx, none on a 4xx; and nothing without the
 * secret. The receiver is a fetch spy.
 */
const warn = mock(() => {});
const debug = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, debug, info: () => {}, error: () => {} } }));
const { CALLBACK_ATTEMPT_DELAYS_MS, callbackPayload, notifyCallback, readCallbackUrl, signCallback } = await import(
  "@/lib/notify/callback"
);

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
const saved: Record<string, string | undefined> = {};
const record: ApprovalRequest = {
  id: "exec-1",
  kind: "execution",
  datasourceId: "orders",
  datasourceName: "Orders",
  requester: "svc:bot",
  subject: "ana",
  statement: "SELECT id FROM orders LIMIT 5",
  route: "POST /api/v1/executions",
  status: "approved",
  requestedAt: "2026-09-14T00:00:00.000Z",
  reviewer: "root",
  reviewedAt: "2026-09-14T00:01:00.000Z",
  ticket: "INC-1",
  callback: { url: "https://bot.example.test/hook" },
  execution: {
    status: "done",
    rowCount: 1,
    fields: ["id"],
    rows: [{ id: 1 }],
    durationMs: 3,
    startedAt: "2026-09-14T00:02:00.000Z",
    finishedAt: "2026-09-14T00:02:00.003Z",
  },
};

describe("callback", () => {
  beforeEach(() => {
    for (const k of ["CALLBACK_SIGNING_SECRET", "CALLBACK_ALLOWED_HOSTS"]) saved[k] = process.env[k];
    process.env.CALLBACK_SIGNING_SECRET = "shared";
    process.env.CALLBACK_ALLOWED_HOSTS = "bot.example.test, Other.Example.Test";
    fetchSpy = spyOn(holder, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    warn.mockClear();
    debug.mockClear();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const k of ["CALLBACK_SIGNING_SECRET", "CALLBACK_ALLOWED_HOSTS"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("readCallbackUrl takes an https URL on an allowed host and names every other reason", () => {
    expect(readCallbackUrl("https://bot.example.test/hook?x=1")).toEqual({ url: "https://bot.example.test/hook?x=1" });
    expect(readCallbackUrl("https://OTHER.example.test/h")).toEqual({ url: "https://other.example.test/h" });
    expect(readCallbackUrl("http://bot.example.test/hook")).toEqual({ error: "callback.url must be https" });
    expect(readCallbackUrl("https://u:p@bot.example.test/hook")).toEqual({
      error: "callback.url may not carry credentials",
    });
    expect(readCallbackUrl("https://elsewhere.test/hook")).toEqual({
      error: 'callback.url host "elsewhere.test" is not in CALLBACK_ALLOWED_HOSTS',
    });
    expect(readCallbackUrl("not a url")).toEqual({ error: "callback.url must be an absolute URL" });
    expect(readCallbackUrl(42)).toEqual({ error: "callback.url must be a string" });
    expect(readCallbackUrl(`https://bot.example.test/${"x".repeat(600)}`)).toEqual({
      error: "callback.url must be a string",
    });
    delete process.env.CALLBACK_SIGNING_SECRET;
    expect(readCallbackUrl("https://bot.example.test/hook")).toEqual({
      error: "Callbacks are not enabled on this server (CALLBACK_SIGNING_SECRET)",
    });
  });

  test("delivers the outcome signed over timestamp and body, with the event and delivery headers", async () => {
    expect(await notifyCallback(record, [0])).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bot.example.test/hook");
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual(callbackPayload(record));
    expect(JSON.parse(body)).toMatchObject({
      id: "exec-1",
      status: "approved",
      ticket: "INC-1",
      reviewer: "root",
      execution: { status: "done" },
    });
    expect(body).not.toContain("callback");
    expect(body).not.toContain("SELECT");
    expect(headers["X-Dbportal-Event"]).toBe("execution.done");
    expect(headers["X-Dbportal-Delivery"]).toBe("exec-1:1");
    const expected = `v1=${createHmac("sha256", "shared").update(`${headers["X-Dbportal-Timestamp"]}.${body}`).digest("hex")}`;
    expect(headers["X-Dbportal-Signature"]).toBe(expected);
    expect(signCallback("b", "1", "shared")).toMatch(/^v1=[0-9a-f]{64}$/);
    // A rejection has no execution: the event is the record's status.
    await notifyCallback({ ...record, status: "rejected", execution: undefined }, [0]);
    expect(
      ((fetchSpy.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>)["X-Dbportal-Event"],
    ).toBe("execution.rejected");
  });

  test("tries again after a network failure or a 5xx, stops at a 4xx, and warns once when every attempt failed", async () => {
    fetchSpy
      .mockImplementationOnce(async () => {
        throw new TypeError("down");
      })
      .mockImplementationOnce(async () => new Response("", { status: 503 }))
      .mockImplementationOnce(async () => new Response("", { status: 200 }));
    expect(await notifyCallback(record, [0, 0, 0])).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(async () => new Response("", { status: 410 }));
    expect(await notifyCallback(record, [0, 0, 0])).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();
    warn.mockClear();
    fetchSpy.mockImplementation(async () => new Response("", { status: 500 }));
    expect(await notifyCallback(record, [0, 0, 0])).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(CALLBACK_ATTEMPT_DELAYS_MS).toEqual([0, 2_000, 10_000]);
  });

  test("nothing is sent without a URL on the record or without the secret", async () => {
    expect(await notifyCallback({ ...record, callback: undefined }, [0])).toBe(false);
    delete process.env.CALLBACK_SIGNING_SECRET;
    expect(await notifyCallback(record, [0])).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
