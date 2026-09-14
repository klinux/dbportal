import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The channel routes an administrator calls (docs/CONTEXT.md §4.29): the list with targets
 * and sources, a declaration with an audit line, deletion refusing what the store refuses,
 * and a test message whose outcome is audited either way.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const real = await import("@/lib/channels/store");
const { ChannelError } = real;
const ops = { id: "ops", name: "Ops", kind: "slack", target: "C1" };
const store = {
  list: mock(async () => [{ channel: ops, source: "store" }]),
  save: mock(async () => ({ ...ops, createdAt: "x", createdBy: "root" })),
  remove: mock(async (_id: string, _inUse: unknown) => ({ ...ops, createdAt: "x", createdBy: "root" })),
  find: mock(async (id: string) => (id === "ops" ? ops : null)),
};
mock.module("@/lib/channels/store", () => ({
  ...real,
  listChannels: () => store.list(),
  saveChannel: (...a: unknown[]) => store.save(...(a as [])),
  deleteChannel: (...a: unknown[]) => store.remove(...(a as [string, unknown])),
  findChannel: (id: string) => store.find(id),
}));
const realAlerts = await import("@/lib/alerts/store");
mock.module("@/lib/alerts/store", () => ({ ...realAlerts, channelInUse: async () => false }));
const deliver = mock(async (_c: unknown, _m: unknown) => true);
mock.module("@/lib/notify/channels", () => ({ deliverToChannel: deliver }));

const { GET, POST } = await import("@/app/api/admin/channels/route");
const { DELETE } = await import("@/app/api/admin/channels/[id]/route");
const { POST: TEST } = await import("@/app/api/admin/channels/[id]/test/route");

const url = "http://localhost/api/admin/channels";
const json = (body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("admin channel routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "admin", username: "root" };
    audit.mockClear();
    deliver.mockClear();
  });

  test("admin only", async () => {
    session = { role: "user", username: "ana" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json(ops))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("ops"))).status).toBe(403);
    expect((await TEST(new Request(url, { method: "POST" }), params("ops"))).status).toBe(403);
  });

  test("lists with source and target, declares with an audit line, refuses a body that is not an object", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({ channels: [{ ...ops, source: "store" }] });
    const created = await POST(json(ops));
    expect(created.status).toBe(201);
    expect((await created.json()).channel).toMatchObject({ id: "ops", source: "store" });
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "notification_channel",
      action: "saved",
      target: "ops",
      details: "slack",
    });
    expect((await POST(new Request(url, { method: "POST", body: "[]" }))).status).toBe(400);
    store.save.mockImplementationOnce(async () => {
      throw new ChannelError("Invalid channel: kind", 400);
    });
    expect((await POST(json({}))).status).toBe(400);
    store.list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });

  test("deletes with an audit line and answers the store's refusal", async () => {
    expect(await (await DELETE(new Request(url, { method: "DELETE" }), params("ops"))).json()).toEqual({
      deleted: "ops",
    });
    expect(audit.mock.calls[0][0]).toMatchObject({ type: "notification_channel", action: "deleted", target: "ops" });
    store.remove.mockImplementationOnce(async () => {
      throw new ChannelError("in use", 409);
    });
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("ops"))).status).toBe(409);
  });

  test("a test message: delivered or not, both audited; an unknown channel is 404", async () => {
    expect(await (await TEST(new Request(url, { method: "POST" }), params("ops"))).json()).toEqual({ delivered: true });
    expect(deliver.mock.calls[0][0]).toEqual(ops);
    expect(deliver.mock.calls[0][1]).toMatchObject({ state: "test", alertId: "test", condition: "sent by root" });
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "notification_channel",
      action: "tested",
      target: "ops",
      result: "success",
    });
    deliver.mockImplementationOnce(async () => false);
    expect(await (await TEST(new Request(url, { method: "POST" }), params("ops"))).json()).toEqual({
      delivered: false,
    });
    expect(audit.mock.calls[1][0]).toMatchObject({ action: "tested", result: "failure" });
    expect((await TEST(new Request(url, { method: "POST" }), params("ghost"))).status).toBe(404);
  });
});
