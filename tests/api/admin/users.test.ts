import { describe, test, expect, mock } from "bun:test";

/** The users route (docs/CONTEXT.md §4.60): admin only, the listing as the lib answers it, a failed read a 500. */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: () => ({}) }));
const listing = { available: true, users: [], windowDays: 30, countsCapped: false };
const list = mock(async () => listing);
mock.module("@/lib/portal-users", () => ({ listPortalUsers: list }));

const { GET } = await import("@/app/api/admin/users/route");
const url = "http://localhost/api/admin/users";

describe("GET /api/admin/users", () => {
  test("answers the listing to an administrator, 403 to anyone else, 500 when it cannot be read", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual(listing);
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    session = { role: "admin", username: "root" };
    list.mockImplementationOnce(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
