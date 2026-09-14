import { describe, test, expect, beforeEach, spyOn, mock } from "bun:test";
// docs/CONTEXT.md §4.17: the freeze store is mocked here; tests/unit/freezes/store.test.ts owns it.
let frozenWindow: { id: string; reason: string; from: string; until: string } | null = null;
mock.module("@/lib/freezes/store", () => ({
  activeFreeze: async () => frozenWindow,
}));

import { assertWriteAllowed, providerAccessOptions } from "@/lib/api/write-gate";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { ManagedConnection } from "@/lib/seed";

/**
 * The write gate every execution route runs (docs/CONTEXT.md §4.4): what it lets through,
 * what it refuses, and the trail a refusal leaves.
 */
const base: ManagedConnection = {
  // docs/CONTEXT.md §4.15: the guardrails are proven in tests/unit/lib/api/write-gate-approval.test.ts;
  // this file is about something else, and a bare DELETE or DROP here must reach what it tests.
  guardrails: false,
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  type: "postgres",
  managed: true,
  roles: ["*"],
  createdAt: new Date(0),
};
const request = new Request("http://localhost/api/db/query", { method: "POST" });
const session = { role: "user" as const, username: "bob" };

describe("assertWriteAllowed", () => {
  beforeEach(() => {
    clearRateLimitState();
  });

  // docs/CONTEXT.md §4.17: inside a window a write is refused with the window's words, a read is not.
  test("a freeze window refuses a write with its end and reason, and lets a read through", async () => {
    frozenWindow = {
      id: "w",
      reason: "Release 42 deploy",
      from: "2026-09-14T00:00:00.000Z",
      until: "2026-09-14T02:00:00.000Z",
    };
    try {
      const err = await assertWriteAllowed({
        route: "r",
        session,
        connection: base,
        statements: ["DELETE FROM t WHERE id = 1"],
        request,
      }).catch((e) => e);
      expect(err.statusCode).toBe(403);
      expect(err.message).toBe('Writes on "Orders" are frozen until 2026-09-14T02:00:00.000Z: Release 42 deploy');
      expect(
        await assertWriteAllowed({ route: "r", session, connection: base, statements: ["SELECT 1"], request }),
      ).toEqual({});
    } finally {
      frozenWindow = null;
    }
  });

  test("lets everything through when the session may write", async () => {
    expect(
      await assertWriteAllowed({ route: "r", session, connection: base, statements: ["DROP TABLE t"], request }),
    ).toEqual({});
    expect(providerAccessOptions(base, session)).toEqual({});
  });

  test("lets reads through on a read-only datasource, and asks the engine for a read-only pool", async () => {
    const readOnly = { ...base, writeRoles: [] };
    expect(
      await assertWriteAllowed({
        route: "r",
        session,
        connection: readOnly,
        statements: ["SELECT 1", "EXPLAIN SELECT 2"],
        request,
      }),
    ).toEqual({});
    expect(providerAccessOptions(readOnly, session)).toEqual({ readOnly: true });
  });

  // The refusal is a 403 the shared error mapper already understands, and a metered
  // permission_denied line with the datasource's own reason - never the statement.
  test("refuses a write on a read-only datasource with a 403 and an audited reason", async () => {
    const readOnly = { ...base, writeRoles: ["group:dba"] };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const err = await assertWriteAllowed({
        route: "POST /api/db/query",
        session,
        connection: readOnly,
        statements: ["SELECT 1", "UPDATE t SET secret = 'hunter2'"],
        request,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
      expect((err as SeedConnectionError).message).toContain("read-only");
      const lines = (logSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
        .map((v) => JSON.parse(v) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        event: "permission_denied",
        reason: "read_only_datasource",
        actor: "bob",
        route: "POST /api/db/query",
      });
      expect(JSON.stringify(lines[0])).not.toContain("hunter2");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a member of a writing group is not refused", async () => {
    const dbaOnly = { ...base, writeRoles: ["group:dba"] };
    expect(
      await assertWriteAllowed({
        route: "r",
        session: { ...session, groups: ["dba"] },
        connection: dbaOnly,
        statements: ["DELETE FROM t"],
        request,
      }),
    ).toEqual({});
  });
});
