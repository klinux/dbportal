import { describe, test, expect, mock } from "bun:test";

/** The principals route (docs/CONTEXT.md §4.37): admin only, the list as the source answers it, a failed read a 500. */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
const list = mock(async () => [{ id: "group:sre", kind: "group", source: "role On-call" }]);
mock.module("@/lib/principals", () => ({ listKnownPrincipals: list }));

const { GET } = await import("@/app/api/admin/principals/route");
const url = "http://localhost/api/admin/principals";

describe("GET /api/admin/principals", () => {
  test("answers the list to an administrator, 403 to anyone else, 500 when the sources cannot be read", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({
      principals: [{ id: "group:sre", kind: "group", source: "role On-call" }],
    });
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    session = { role: "admin", username: "root" };
    list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
