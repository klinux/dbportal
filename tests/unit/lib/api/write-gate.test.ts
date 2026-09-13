import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { assertWriteAllowed, providerAccessOptions } from "@/lib/api/write-gate";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { ManagedConnection } from "@/lib/seed";

/**
 * The write gate every execution route runs (docs/CONTEXT.md §4.4): what it lets through,
 * what it refuses, and the trail a refusal leaves.
 */
const base: ManagedConnection = {
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

  test("lets everything through when the session may write", () => {
    expect(() =>
      assertWriteAllowed({ route: "r", session, connection: base, statements: ["DROP TABLE t"], request }),
    ).not.toThrow();
    expect(providerAccessOptions(base, session)).toEqual({});
  });

  test("lets reads through on a read-only datasource, and asks the engine for a read-only pool", () => {
    const readOnly = { ...base, writeRoles: [] };
    expect(() =>
      assertWriteAllowed({
        route: "r",
        session,
        connection: readOnly,
        statements: ["SELECT 1", "EXPLAIN SELECT 2"],
        request,
      }),
    ).not.toThrow();
    expect(providerAccessOptions(readOnly, session)).toEqual({ readOnly: true });
  });

  // The refusal is a 403 the shared error mapper already understands, and a metered
  // permission_denied line with the datasource's own reason - never the statement.
  test("refuses a write on a read-only datasource with a 403 and an audited reason", () => {
    const readOnly = { ...base, writeRoles: ["group:dba"] };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      try {
        assertWriteAllowed({
          route: "POST /api/db/query",
          session,
          connection: readOnly,
          statements: ["SELECT 1", "UPDATE t SET secret = 'hunter2'"],
          request,
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SeedConnectionError);
        expect((err as SeedConnectionError).statusCode).toBe(403);
        expect((err as SeedConnectionError).message).toContain("read-only");
      }
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

  test("a member of a writing group is not refused", () => {
    const dbaOnly = { ...base, writeRoles: ["group:dba"] };
    expect(() =>
      assertWriteAllowed({
        route: "r",
        session: { ...session, groups: ["dba"] },
        connection: dbaOnly,
        statements: ["DELETE FROM t"],
        request,
      }),
    ).not.toThrow();
  });
});
