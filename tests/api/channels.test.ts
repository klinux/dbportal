import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The channel routes a session calls (docs/CONTEXT.md §4.29): the list with id, name, kind
 * and who declared each - never the target; a declaration as the person (an administrator's
 * session declares as one), deletion and a test message of one's own, and the Slack
 * channels by name - 503 without the bot, 502 when Slack refuses.
 */
let session: { role: string; username: string } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const real = await import("@/lib/channels/store");
const { ChannelError } = real;
const ops = { id: "ops", name: "Ops", kind: "slack", target: "C1" };
const anas = { id: "anas", name: "Ana's", kind: "slack", target: "C2", createdAt: "x", createdBy: "ana" };
const store = {
  list: mock(async () => [
    { channel: ops, source: "config" },
    { channel: anas, source: "store" },
  ]),
  save: mock(async (_input: unknown, _actor: unknown) => anas),
  remove: mock(async (_id: string, _inUse: unknown, _actor: unknown) => anas),
};
mock.module("@/lib/channels/store", () => ({
  ...real,
  listChannels: () => store.list(),
  saveChannel: (i: unknown, a: unknown) => store.save(i, a),
  deleteChannel: (id: string, u: unknown, a: unknown) => store.remove(id, u, a),
  findChannel: async (id: string) => (id === "ops" ? ops : id === "anas" ? anas : null),
}));
const realAlerts = await import("@/lib/alerts/store");
mock.module("@/lib/alerts/store", () => ({ ...realAlerts, channelInUse: async () => false }));
const deliver = mock(async (_c: unknown, _m: unknown) => true);
mock.module("@/lib/notify/channels", () => ({ deliverToChannel: deliver }));
let slackOn = true;
const slackList = mock(async (_q: string) => [{ id: "C1", name: "ops", private: false }]);
mock.module("@/lib/notify/slack", () => ({ slackConfigured: () => slackOn, listSlackChannels: slackList }));

const { GET, POST } = await import("@/app/api/channels/route");
const { DELETE } = await import("@/app/api/channels/[id]/route");
const { POST: TEST } = await import("@/app/api/channels/[id]/test/route");
const { GET: SLACK } = await import("@/app/api/channels/slack/route");

const url = "http://localhost/api/channels";
const json = (body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/channels", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
    audit.mockClear();
    deliver.mockClear();
    store.save.mockClear();
    store.remove.mockClear();
    slackOn = true;
  });

  test("a session is required everywhere", async () => {
    session = null;
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await POST(json(ops))).status).toBe(401);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("anas"))).status).toBe(401);
    expect((await TEST(new Request(url, { method: "POST" }), params("anas"))).status).toBe(401);
    expect((await SLACK(new Request(`${url}/slack`))).status).toBe(401);
  });

  test("lists summaries with who declared each, never the target; 500 when the store fails", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({
      channels: [
        { id: "ops", name: "Ops", kind: "slack" },
        { id: "anas", name: "Ana's", kind: "slack", createdBy: "ana" },
      ],
    });
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });

  test("declares as the person - an administrator's session as an administrator - with an audit line; the store's refusals come back", async () => {
    const created = await POST(json({ id: "anas", name: "Ana's", kind: "slack", target: "C2" }));
    expect(created.status).toBe(201);
    expect((await created.json()).channel).toEqual({ id: "anas", name: "Ana's", kind: "slack", createdBy: "ana" });
    expect(store.save.mock.calls[0][1]).toEqual({ username: "ana", admin: false });
    expect(audit.mock.calls[0][0]).toMatchObject({ type: "notification_channel", action: "saved", user: "ana" });
    session = { role: "admin", username: "root" };
    await POST(json(ops));
    expect(store.save.mock.calls[1][1]).toEqual({ username: "root", admin: true });
    expect((await POST(new Request(url, { method: "POST", body: "[]" }))).status).toBe(400);
    store.save.mockImplementationOnce(async () => {
      throw new ChannelError("host not allowed", 403);
    });
    expect((await POST(json(ops))).status).toBe(403);
  });

  test("deletes and tests one's own; someone else's is refused or not found", async () => {
    expect(await (await DELETE(new Request(url, { method: "DELETE" }), params("anas"))).json()).toEqual({
      deleted: "anas",
    });
    expect(store.remove.mock.calls[0][2]).toEqual({ username: "ana", admin: false });
    store.remove.mockImplementationOnce(async () => {
      throw new ChannelError("someone else's", 403);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("ops"))).status).toBe(403);
    expect(await (await TEST(new Request(url, { method: "POST" }), params("anas"))).json()).toEqual({
      delivered: true,
    });
    expect(deliver.mock.calls[0][1]).toMatchObject({ state: "test", condition: "sent by ana" });
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({ action: "tested", result: "success" });
    // A seed-file channel is nobody's but an administrator's.
    expect((await TEST(new Request(url, { method: "POST" }), params("ops"))).status).toBe(404);
    expect((await TEST(new Request(url, { method: "POST" }), params("ghost"))).status).toBe(404);
    session = { role: "admin", username: "root" };
    deliver.mockImplementationOnce(async () => false);
    expect(await (await TEST(new Request(url, { method: "POST" }), params("ops"))).json()).toEqual({
      delivered: false,
    });
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({ action: "tested", result: "failure" });
  });

  test("the Slack channels by name: the query passed on, 503 without the bot, 502 when Slack refuses, 500 otherwise", async () => {
    expect(await (await SLACK(new Request(`${url}/slack?q=op`))).json()).toEqual({
      channels: [{ id: "C1", name: "ops", private: false }],
    });
    expect(slackList).toHaveBeenLastCalledWith("op");
    slackOn = false;
    expect((await SLACK(new Request(`${url}/slack`))).status).toBe(503);
    slackOn = true;
    slackList.mockImplementationOnce(async () => {
      throw new Error("Slack answered missing_scope");
    });
    const refused = await SLACK(new Request(`${url}/slack`));
    expect(refused.status).toBe(502);
    expect(JSON.stringify(await refused.json())).not.toContain("missing_scope");
    slackList.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect((await SLACK(new Request(`${url}/slack`))).status).toBe(500);
  });
});
