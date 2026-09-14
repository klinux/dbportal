import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/** The channel list a session reads (docs/CONTEXT.md §4.29): id, name and kind only, never where a channel goes. */
let session: { role: string; username: string } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
const real = await import("@/lib/channels/store");
const list = mock(async () => [
  { channel: { id: "ops", name: "Ops", kind: "slack", target: "C1" }, source: "config" },
  { channel: { id: "hook", name: "Hook", kind: "webhook", target: "https://h.test/x" }, source: "store" },
]);
mock.module("@/lib/channels/store", () => ({ ...real, listChannels: list }));
const { GET } = await import("@/app/api/channels/route");
const url = "http://localhost/api/channels";

describe("GET /api/channels", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
  });

  test("answers the summaries to a session, 401 without one, 500 when the store fails", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({
      channels: [
        { id: "ops", name: "Ops", kind: "slack" },
        { id: "hook", name: "Hook", kind: "webhook" },
      ],
    });
    session = null;
    expect((await GET(new Request(url))).status).toBe(401);
    session = { role: "user", username: "ana" };
    list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
