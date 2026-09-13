import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The approvals API (docs/CONTEXT.md §4.6) over a mocked store: who sees what, who may
 * decide, and how the store's own refusals come back. The store's rules are proven in
 * tests/unit/approvals/store.test.ts; this file proves the HTTP around them.
 */
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string; groups?: string[] } | null> => ({
    role: "admin",
    username: "root",
  }),
);
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "t"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

const pending: ApprovalRequest = {
  id: "req-1",
  datasourceId: "orders",
  datasourceName: "Orders",
  requester: "ana",
  statement: "DELETE FROM t",
  route: "POST /api/db/query",
  status: "pending",
  requestedAt: "2026-09-13T00:00:00.000Z",
};
const mockListForReviewer = mock(async () => [pending]);
const mockListMine = mock(async () => [pending]);
const mockGetApproval = mock(async (id: string) => (id === "req-1" ? pending : null));
const mockCanReview = mock(async (_r: ApprovalRequest, s: { role: string }) => s.role === "admin");
const mockDecide = mock(async (input: { decision: string }) => ({
  ...pending,
  status: input.decision === "approve" ? "approved" : "rejected",
  reviewer: "root",
}));
mock.module("@/lib/approvals/store", () => ({
  listForReviewer: mockListForReviewer,
  listMine: mockListMine,
  getApproval: mockGetApproval,
  canReview: mockCanReview,
  decideApproval: mockDecide,
}));

const { GET: list } = await import("@/app/api/approvals/route");
const { GET: getOne, POST: decide } = await import("@/app/api/approvals/[id]/route");
const { ApprovalError } = await import("@/lib/approvals/errors");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("approvals API", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "root" }));
    mockDecide.mockClear();
  });

  test("every route requires a session", async () => {
    mockGetSession.mockImplementation(async () => null);
    expect((await list(createMockRequest("/api/approvals"))).status).toBe(401);
    expect((await getOne(createMockRequest("/api/approvals/req-1"), params("req-1"))).status).toBe(401);
    expect(
      (
        await decide(
          createMockRequest("/api/approvals/req-1", { method: "POST", body: { decision: "approve" } }),
          params("req-1"),
        )
      ).status,
    ).toBe(401);
  });

  test("the list is the reviewer's by default and the caller's own with ?scope=mine", async () => {
    const reviewer = await parseResponseJSON<{ approvals: ApprovalRequest[] }>(
      await list(createMockRequest("/api/approvals")),
    );
    expect(reviewer.approvals).toEqual([pending]);
    expect(mockListForReviewer).toHaveBeenCalledWith({ role: "admin", username: "root" });
    await list(createMockRequest("/api/approvals?scope=mine"));
    expect(mockListMine).toHaveBeenCalledWith("root");
  });

  test("one request is visible to its requester and to a reviewer, and 404 to anyone else", async () => {
    expect((await getOne(createMockRequest("/api/approvals/req-1"), params("req-1"))).status).toBe(200);
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "ana" }));
    expect((await getOne(createMockRequest("/api/approvals/req-1"), params("req-1"))).status).toBe(200);
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));
    expect((await getOne(createMockRequest("/api/approvals/req-1"), params("req-1"))).status).toBe(404);
    expect((await getOne(createMockRequest("/api/approvals/nope"), params("nope"))).status).toBe(404);
  });

  test("a decision is recorded for a reviewer, with the window minutes and note passed along", async () => {
    const res = await decide(
      createMockRequest("/api/approvals/req-1", {
        method: "POST",
        body: { decision: "approve", windowMinutes: 60, note: "ok" },
      }),
      params("req-1"),
    );
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ approval: ApprovalRequest }>(res)).approval.status).toBe("approved");
    expect(mockDecide).toHaveBeenCalledWith({
      id: "req-1",
      reviewer: "root",
      decision: "approve",
      windowMinutes: 60,
      note: "ok",
    });
  });

  test("a non-reviewer's decision is a 403, an unknown id a 404, a malformed body a 400", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));
    const forbidden = await decide(
      createMockRequest("/api/approvals/req-1", { method: "POST", body: { decision: "approve" } }),
      params("req-1"),
    );
    expect(forbidden.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();

    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "root" }));
    expect(
      (
        await decide(
          createMockRequest("/api/approvals/nope", { method: "POST", body: { decision: "approve" } }),
          params("nope"),
        )
      ).status,
    ).toBe(404);
    for (const body of [{ decision: "maybe" }, ["approve"], "nope"]) {
      const res = await decide(createMockRequest("/api/approvals/req-1", { method: "POST", body }), params("req-1"));
      expect(res.status).toBe(400);
    }
    const notJson = new Request("http://localhost:3000/api/approvals/req-1", { method: "POST", body: "{" });
    expect((await decide(notJson, params("req-1"))).status).toBe(400);
  });

  test("the store's own refusal comes back with its status, and anything else through the shared mapper", async () => {
    mockDecide.mockImplementationOnce(async () => {
      throw new ApprovalError("You cannot review your own request", 403);
    });
    const own = await decide(
      createMockRequest("/api/approvals/req-1", { method: "POST", body: { decision: "reject" } }),
      params("req-1"),
    );
    expect(own.status).toBe(403);
    expect((await parseResponseJSON<{ error: string }>(own)).error).toContain("your own");

    mockListForReviewer.mockImplementationOnce(async () => {
      throw new Error("store down");
    });
    expect((await list(createMockRequest("/api/approvals"))).status).toBe(500);
    mockGetApproval.mockImplementationOnce(async () => {
      throw new ApprovalError("Write approval needs server storage", 503);
    });
    expect((await getOne(createMockRequest("/api/approvals/req-1"), params("req-1"))).status).toBe(503);
  });
});
