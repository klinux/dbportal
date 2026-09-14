import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import type { ApprovalQuery, ApprovalRequest } from "@/lib/storage/types";

/**
 * The write-approval store (docs/CONTEXT.md §4.6) against an in-memory stand-in for the
 * server storage provider: one pending request per person and datasource, the window an
 * approval opens, four eyes on every decision, and the audit line each decision leaves.
 */
let rows = new Map<string, ApprovalRequest>();
let enabled = true;
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
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, query.limit),
  ),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled ? provider : null),
}));
const datasources: Record<string, { approverRoles?: string[] }> = {
  orders: { approverRoles: ["group:dba"] },
  plain: {},
};
mock.module("@/lib/seed", () => ({
  getSeedConnectionByIdUnfiltered: async (id: string) => datasources[id] ?? null,
}));

const {
  DEFAULT_WINDOW_MINUTES,
  canReview,
  decideApproval,
  findOpenWindow,
  getApproval,
  isWindowOpen,
  listForReviewer,
  listMine,
  requestApproval,
  requireWriteWindow,
} = await import("@/lib/approvals/store");
const { ApprovalError, ApprovalRequiredError } = await import("@/lib/approvals/errors");

const ask = (requester = "ana", datasourceId = "orders") =>
  requestApproval({
    datasourceId,
    datasourceName: "Orders",
    requester,
    statement: "DELETE FROM orders WHERE id = 1",
    route: "POST /api/db/query",
  });

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return error instanceof ApprovalError ? error.statusCode : -1;
  }
}

describe("approvals store", () => {
  // docs/CONTEXT.md §4.10: a queued execution has nobody present to run again, so its
  // approval carries no window - the decision runs the stored statement (elsewhere).
  it("approving an execution request records the reviewer and no window, and ignores windowMinutes", async () => {
    const queued: ApprovalRequest = {
      id: "exec-1",
      kind: "execution",
      datasourceId: "orders",
      datasourceName: "Orders",
      requester: "svc:bot",
      subject: "U01",
      statement: "SELECT 1",
      route: "POST /api/v1/executions",
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    rows.set(queued.id, queued);
    const decided = await decideApproval({
      id: "exec-1",
      reviewer: "root",
      decision: "approve",
      windowMinutes: "garbage",
    });
    expect(decided.status).toBe("approved");
    expect(decided.reviewer).toBe("root");
    expect(decided.windowUntil).toBeUndefined();
    expect(decided.kind).toBe("execution");
  });

  beforeEach(() => {
    rows = new Map();
    enabled = true;
    provider.putApproval.mockClear();
  });

  it("without server storage every operation is a 503 that says what to configure", async () => {
    enabled = false;
    expect(await status(ask())).toBe(503);
    expect(await status(findOpenWindow("orders", "ana"))).toBe(503);
    expect(await status(listMine("ana"))).toBe(503);
    await expect(getApproval("x")).rejects.toThrow("STORAGE_PROVIDER");
  });

  it("a request is created once per person and datasource, with the statement bounded", async () => {
    const first = await requestApproval({
      datasourceId: "orders",
      datasourceName: "Orders",
      requester: "ana",
      statement: "x".repeat(5000),
      route: "POST /api/db/query",
    });
    expect(first.status).toBe("pending");
    expect(first.statement).toHaveLength(4000);
    const again = await ask("ana");
    expect(again.id).toBe(first.id);
    const bob = await ask("bob");
    expect(bob.id).not.toBe(first.id);
    expect(provider.putApproval).toHaveBeenCalledTimes(2);
  });

  it("requireWriteWindow throws the pending request when no window is open, and answers the window when one is", async () => {
    const input = {
      datasourceId: "orders",
      datasourceName: "Orders",
      requester: "ana",
      statement: "DELETE FROM t",
      route: "POST /api/db/query",
    };
    const err = await requireWriteWindow(input).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(err.approval.status).toBe("pending");
    expect(err.message).toContain(err.approval.id);

    const approved = await decideApproval({ id: err.approval.id, reviewer: "root", decision: "approve" });
    expect((await requireWriteWindow(input)).id).toBe(approved.id);
    expect((await findOpenWindow("orders", "ana"))?.id).toBe(approved.id);
    expect(await findOpenWindow("orders", "bob")).toBeNull();
  });

  it("an approval opens a window of the reviewer's minutes (default 15, bounded 1..240) and audits the decision", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const pending = await ask();
      const before = Date.now();
      const approved = await decideApproval({ id: pending.id, reviewer: "root", decision: "approve", note: "go" });
      expect(approved.status).toBe("approved");
      expect(approved.reviewer).toBe("root");
      expect(approved.note).toBe("go");
      const until = Date.parse(approved.windowUntil!);
      expect(until).toBeGreaterThanOrEqual(before + DEFAULT_WINDOW_MINUTES * 60_000);
      expect(isWindowOpen(approved)).toBe(true);
      expect(isWindowOpen(approved, until + 1)).toBe(false);

      const lines = (logSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
        .map((v) => JSON.parse(v) as Record<string, unknown>);
      expect(lines.find((l) => l.event === "approval_decision")).toMatchObject({
        action: "approve",
        actor: "root",
        route: "orders",
        connection: "Orders",
        approval_id: pending.id,
        reviewer: "root",
      });
      expect(JSON.stringify(lines)).not.toContain("DELETE FROM");

      const bob = await ask("bob");
      for (const bad of [0, 241, 1.5, "ten"]) {
        expect(
          await status(decideApproval({ id: bob.id, reviewer: "root", decision: "approve", windowMinutes: bad })),
        ).toBe(400);
      }
      const hour = await decideApproval({ id: bob.id, reviewer: "root", decision: "approve", windowMinutes: 60 });
      expect(Date.parse(hour.windowUntil!) - Date.parse(hour.reviewedAt!)).toBe(60 * 60_000);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a rejection closes the request without a window; a decided request is not decided again", async () => {
    const pending = await ask();
    const rejected = await decideApproval({ id: pending.id, reviewer: "root", decision: "reject" });
    expect(rejected.status).toBe("rejected");
    expect(rejected).not.toHaveProperty("windowUntil");
    expect(await status(decideApproval({ id: pending.id, reviewer: "root", decision: "approve" }))).toBe(409);
    expect(await status(decideApproval({ id: "missing", reviewer: "root", decision: "approve" }))).toBe(404);
    expect(await findOpenWindow("orders", "ana")).toBeNull();
  });

  // Four eyes: the person who asked is never the person who grants, whatever their role.
  it("nobody reviews their own request, and a note must be a string", async () => {
    const pending = await ask("root");
    expect(await status(decideApproval({ id: pending.id, reviewer: "root", decision: "approve" }))).toBe(403);
    expect(await status(decideApproval({ id: pending.id, reviewer: "other", decision: "approve", note: 5 }))).toBe(400);
  });

  it("a broken audit sink does not undo a decision already stored", async () => {
    const pending = await ask();
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await decideApproval({ id: pending.id, reviewer: "root", decision: "approve" })).status).toBe("approved");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("canReview follows the datasource's approverRoles, and falls back to administrators for an unknown datasource", async () => {
    const onOrders = await ask("ana", "orders");
    const onPlain = await ask("ana", "plain");
    const onGone = await ask("ana", "gone");
    expect(await canReview(onOrders, { role: "user", groups: ["dba"] })).toBe(true);
    expect(await canReview(onOrders, { role: "admin" })).toBe(false);
    expect(await canReview(onPlain, { role: "admin" })).toBe(true);
    expect(await canReview(onGone, { role: "admin" })).toBe(true);
    expect(await canReview(onGone, { role: "user" })).toBe(false);
  });

  it("listForReviewer answers what the session may review, pending first; listMine answers the requester's own", async () => {
    const a = await ask("ana", "orders");
    const b = await ask("bob", "plain");
    await decideApproval({ id: b.id, reviewer: "root", decision: "reject" });
    const c = await ask("cid", "plain");
    const admin = await listForReviewer({ role: "admin" });
    expect(admin.map((r) => r.id)).toEqual([c.id, b.id]);
    const dba = await listForReviewer({ role: "user", groups: ["dba"] });
    expect(dba.map((r) => r.id)).toEqual([a.id]);
    expect(await listForReviewer({ role: "user" })).toEqual([]);
    expect((await listMine("bob")).map((r) => r.id)).toEqual([b.id]);
    expect(await getApproval(a.id)).toEqual(a);
  });
});
