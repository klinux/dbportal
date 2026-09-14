import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { ApprovalQuery, ApprovalRequest } from "@/lib/storage/types";
import type { ManagedConnection } from "@/lib/seed";

/**
 * The write gate on a datasource that requires approval (docs/CONTEXT.md §4.6): a write
 * without a window becomes a request and is refused as APPROVAL_REQUIRED (audited); inside
 * a window it runs and the gate hands the routes the approval for their audit line. In its
 * own file because the store is mocked here and mock.module is process-wide.
 */
let rows = new Map<string, ApprovalRequest>();
const provider = {
  putApproval: mock(async (record: ApprovalRequest) => {
    rows.set(record.id, { ...record });
  }),
  getApproval: mock(async (id: string) => rows.get(id) ?? null),
  listApprovals: mock(async (query: ApprovalQuery) =>
    [...rows.values()]
      .filter((r) => !query.status || r.status === query.status)
      .filter((r) => !query.requester || r.requester === query.requester)
      .filter((r) => !query.datasourceId || r.datasourceId === query.datasourceId)
      .slice(0, query.limit),
  ),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => true,
  getStorageProvider: async () => provider,
}));
mock.module("@/lib/seed", () => ({
  getSeedConnectionByIdUnfiltered: async () => null,
  getSeedConnectionById: async () => null,
}));

// docs/CONTEXT.md §4.17: the freeze store is mocked here; tests/unit/freezes/store.test.ts owns it.
let frozenWindow: { id: string; reason: string; from: string; until: string } | null = null;
mock.module("@/lib/freezes/store", () => ({
  activeFreeze: async () => frozenWindow,
}));

const { assertWriteAllowed } = await import("@/lib/api/write-gate");
const { decideApproval } = await import("@/lib/approvals/store");
const { ApprovalRequiredError } = await import("@/lib/approvals/errors");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { createErrorResponse } = await import("@/lib/api/errors");

const gated: ManagedConnection = {
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  type: "postgres",
  managed: true,
  roles: ["*"],
  writeApproval: true,
  createdAt: new Date(0),
};
const request = new Request("http://localhost/api/db/query", { method: "POST" });
const session = { role: "user" as const, username: "ana" };
const gate = (statements: string[], conn = gated) =>
  assertWriteAllowed({ route: "POST /api/db/query", session, connection: conn, statements, request });

describe("assertWriteAllowed with write approval", () => {
  beforeEach(() => {
    rows = new Map();
    clearRateLimitState();
  });

  test("reads pass without touching the store", async () => {
    expect(await gate(["SELECT 1", "EXPLAIN SELECT 2"])).toEqual({});
    expect(provider.listApprovals).not.toHaveBeenCalled();
  });

  test("a write without a window becomes a pending request, refused as APPROVAL_REQUIRED and audited", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      // With its WHERE, so this is the write rule alone and not the guardrail of §4.15.
      const err = await gate(["SELECT 1", "UPDATE t SET a = 1 WHERE id = 1"]).catch((e) => e);
      expect(err).toBeInstanceOf(ApprovalRequiredError);
      expect(err.approval).toMatchObject({
        status: "pending",
        datasourceId: "orders",
        requester: "ana",
        statement: "UPDATE t SET a = 1 WHERE id = 1",
      });
      expect(err.approval).not.toHaveProperty("guardrail");
      const res = createErrorResponse(err, { route: "POST /api/db/query" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; approval: { id: string } };
      expect(body.code).toBe("APPROVAL_REQUIRED");
      expect(body.approval.id).toBe(err.approval.id);

      const denial = (logSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
        .map((v) => JSON.parse(v) as Record<string, unknown>)
        .find((e) => e.event === "permission_denied");
      expect(denial).toMatchObject({ reason: "approval_required", actor: "ana", route: "POST /api/db/query" });
      expect(JSON.stringify(denial)).not.toContain("UPDATE");
    } finally {
      logSpy.mockRestore();
    }
  });

  // docs/CONTEXT.md §4.15: a guardrail holds the statement on a datasource WITHOUT write
  // approval too, records which one, and is audited as such; an opt-out lets it through.
  test("a statement that trips a guardrail waits for a reviewer on any datasource, with the guardrail on the record", async () => {
    const plain = { ...gated, writeApproval: undefined };
    const err = await gate(["DELETE FROM orders"], plain).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(err.approval.guardrail).toBe("delete_without_where");
    expect([...rows.values()][0].guardrail).toBe("delete_without_where");
    // A statement that reads, or a write with its WHERE, is not held on that datasource.
    expect(await gate(["DELETE FROM orders WHERE id = 1"], plain)).toEqual({});
    expect(await gate(["SELECT 1"], plain)).toEqual({});
    // Opted out, the same statement runs.
    expect(await gate(["TRUNCATE orders"], { ...plain, guardrails: false })).toEqual({});
    // On a gated datasource the record carries the guardrail as well.
    rows = new Map();
    const gatedErr = await gate(["DROP TABLE orders"]).catch((e) => e);
    expect(gatedErr.approval.guardrail).toBe("drop");
  });

  test("inside a window the write runs, and the gate names the approval and its reviewer", async () => {
    const err = await gate(["DELETE FROM t"]).catch((e) => e);
    await decideApproval({ id: err.approval.id, reviewer: "root", decision: "approve" });
    expect(await gate(["DELETE FROM t"])).toEqual({ approvalId: err.approval.id, reviewer: "root" });
  });

  // Read-only wins: a session that may not write is refused as read-only, never asked to wait.
  test("a session that may not write is refused as read-only before any request is made", async () => {
    const readOnly = { ...gated, writeRoles: [] };
    const err = await gate(["DELETE FROM t"], readOnly).catch((e) => e);
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain("read-only");
    expect(rows.size).toBe(0);
  });

  test("a datasource declared by id alone is keyed by that id", async () => {
    const byId = Object.fromEntries(Object.entries(gated).filter(([key]) => key !== "seedId")) as ManagedConnection;
    const err = await gate(["DELETE FROM t"], byId).catch((e) => e);
    expect(err.approval.datasourceId).toBe("seed:orders");
  });
});
