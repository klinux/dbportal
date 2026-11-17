import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { SeenPrincipalRecord } from "@/lib/storage/types";

/**
 * Who uses the portal (docs/CONTEXT.md §4.60): the people out of the seen-principals document,
 * newest first, each with the sign-ins the audit record holds for them over the window - and
 * the honest answers when there is no store, the record cannot be read, or the window holds
 * more than one listing reads.
 */
let enabled = true;
let principals: SeenPrincipalRecord[] = [];
let events: Array<{ user?: string }> = [];
let auditDown = false;
let providerMissing = false;
const listAuditEvents = mock(async (_query: Record<string, unknown>) => {
  if (auditDown) throw new Error("timeout");
  return events;
});
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled && !providerMissing ? { listAuditEvents } : null),
}));
mock.module("@/lib/principals-seen", () => ({ listSeenPrincipals: async () => principals }));
const { logger } = await import("@/lib/logger");
const { listPortalUsers, SIGN_IN_SCAN_MAX, SIGN_IN_WINDOW_DAYS } = await import("@/lib/portal-users");

const now = new Date("2026-11-17T12:00:00.000Z");

describe("portal users", () => {
  beforeEach(() => {
    enabled = true;
    auditDown = false;
    providerMissing = false;
    listAuditEvents.mockClear();
    principals = [
      { id: "group:sre", firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-11-17T11:00:00.000Z" },
      { id: "user:old@example.test", firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-10-01T00:00:00.000Z" },
      {
        id: "user:ana@example.test",
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        lastSeenAt: "2026-11-17T11:00:00.000Z",
        role: "admin",
        groups: ["sre"],
        method: "oidc",
      },
    ];
    events = [{ user: "ana@example.test" }, { user: "ana@example.test" }, { user: "gone@example.test" }, {}];
  });

  test("lists only people, newest first, with role, groups, method and their sign-ins in the window", async () => {
    const result = await listPortalUsers(now);
    expect(result).toEqual({
      available: true,
      windowDays: SIGN_IN_WINDOW_DAYS,
      countsCapped: false,
      users: [
        {
          username: "ana@example.test",
          firstSeenAt: "2026-10-01T00:00:00.000Z",
          lastSeenAt: "2026-11-17T11:00:00.000Z",
          role: "admin",
          groups: ["sre"],
          method: "oidc",
          signIns: 2,
        },
        // Remembered before §4.60: no role, groups or method, and no sign-ins in the window.
        {
          username: "old@example.test",
          firstSeenAt: "2026-09-01T00:00:00.000Z",
          lastSeenAt: "2026-10-01T00:00:00.000Z",
          signIns: 0,
        },
      ],
    });
    // One read of the record, login successes since the start of the window, bounded.
    expect(listAuditEvents).toHaveBeenCalledWith({
      type: "login_success",
      from: new Date(now.getTime() - SIGN_IN_WINDOW_DAYS * 86_400_000).toISOString(),
      limit: SIGN_IN_SCAN_MAX,
    });
  });

  test("a window fuller than one listing reads says its counts are a floor", async () => {
    events = Array.from({ length: SIGN_IN_SCAN_MAX }, () => ({ user: "ana@example.test" }));
    const result = await listPortalUsers(now);
    expect(result.countsCapped).toBe(true);
    expect(result.users[0].signIns).toBe(SIGN_IN_SCAN_MAX);
  });

  test("an unreadable audit record leaves the people listed and the counts unknown, with a warning", async () => {
    auditDown = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const result = await listPortalUsers(now);
    expect(result.users.map((u) => u.signIns)).toEqual([null, null]);
    expect(result.countsCapped).toBe(false);
    // The error's name only, never its message: a driver message can carry a connection string.
    expect(warn.mock.calls[0][1]).toEqual({ route: "portal-users", error: "Error" });
    warn.mockRestore();
  });

  test("a thrown non-Error is still only a warning", async () => {
    listAuditEvents.mockImplementationOnce(async () => {
      throw "boom";
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    expect((await listPortalUsers(now)).users[0].signIns).toBeNull();
    expect(warn.mock.calls[0][1]).toEqual({ route: "portal-users", error: "error" });
    warn.mockRestore();
  });

  test("a store that is configured but not up yet lists the people with counts unknown", async () => {
    providerMissing = true;
    expect((await listPortalUsers(now)).users.map((u) => u.signIns)).toEqual([null, null]);
  });

  test("without a server store there is nobody to list, and the answer says why", async () => {
    enabled = false;
    expect(await listPortalUsers(now)).toEqual({
      available: false,
      users: [],
      windowDays: SIGN_IN_WINDOW_DAYS,
      countsCapped: false,
    });
    expect(listAuditEvents).not.toHaveBeenCalled();
  });
});
