import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The interactivity endpoint (docs/CONTEXT.md §4.24): the signature first, then the click -
 * who pressed is the reviewer, whether they may is the datasource's rule, nobody decides a
 * request made for them, a decided or missing request is told so, and a decision goes
 * through the same store call the page uses, then settles the execution and rewrites the
 * announcement. The store, the queue and Slack's response URL are mocked.
 */
const secret = "signing-secret";
process.env.SLACK_SIGNING_SECRET = secret;
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const pending: ApprovalRequest = {
  id: "req-1",
  kind: "execution",
  datasourceId: "orders",
  datasourceName: "Orders",
  requester: "svc:slack-bot",
  subject: "U_ASKER",
  statement: "DELETE FROM t WHERE id = 1",
  route: "POST /api/v1/executions",
  status: "pending",
  requestedAt: "2026-09-14T00:00:00.000Z",
};
let record: ApprovalRequest | null = pending;
let reviewerAllowed = true;
const decide = mock(async (input: { id: string; reviewer: string; decision: string }) => ({
  ...pending,
  status: input.decision === "approve" ? "approved" : "rejected",
  reviewer: input.reviewer,
}));
const { ApprovalError } = await import("@/lib/approvals/errors");
mock.module("@/lib/approvals/store", () => ({
  getApproval: async () => record,
  canReview: async () => reviewerAllowed,
  decideApproval: decide,
}));
const settle = mock(async (d: ApprovalRequest) => d);
mock.module("@/lib/executions/store", () => ({ settleDecision: settle }));
const withNamedRoles = mock(async (s: unknown) => s);
mock.module("@/lib/roles/store", () => ({ withNamedRoles }));
const respond = mock(async () => true);
mock.module("@/lib/notify/slack", () => ({
  APPROVE_ACTION: "approval_approve",
  REJECT_ACTION: "approval_reject",
  SLACK_REVIEWER_PREFIX: "slack:",
  respondToInteraction: respond,
}));

const { POST } = await import("@/app/api/slack/interactions/route");

const url = "http://localhost/api/slack/interactions";
function signed(payload: unknown, over: { body?: string; signature?: string; timestamp?: string } = {}) {
  const body = over.body ?? `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    over.signature ?? `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      "x-forwarded-for": "3.3.3.3",
    },
  });
}
const click = (
  action: string,
  user: { id: string; username?: string } = { id: "U_REV", username: "ana" },
  value = "req-1",
) => ({
  type: "block_actions",
  user,
  actions: [{ action_id: action, value }],
  response_url: "https://hooks.slack.com/actions/T/1/abc",
});
const told = () => respond.mock.calls.map((c) => (c as unknown[])[1] as { text: string; replace_original?: boolean });

describe("POST /api/slack/interactions", () => {
  beforeEach(() => {
    clearRateLimitState();
    audit.mockClear();
    decide.mockClear();
    settle.mockClear();
    respond.mockClear();
    record = pending;
    reviewerAllowed = true;
  });

  test("a request whose signature does not verify is a 401 audited as invalid_signature, and decides nothing", async () => {
    const bad = await POST(signed(click("approval_approve"), { signature: "v0=nope" }));
    expect(bad.status).toBe(401);
    expect((audit.mock.calls[0] as unknown[])[0]).toMatchObject({
      type: "permission_denied",
      reason: "invalid_signature",
      ip: "3.3.3.3",
    });
    expect((await POST(new Request(url, { method: "POST", body: "payload=%7B%7D" }))).status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  test("a press approves through the store as slack:<id>, settles the execution and rewrites the announcement", async () => {
    const res = await POST(signed(click("approval_approve")));
    expect(res.status).toBe(200);
    expect(decide.mock.calls[0]?.[0]).toEqual({ id: "req-1", reviewer: "slack:U_REV", decision: "approve" });
    expect(withNamedRoles.mock.calls[0]?.[0]).toEqual({ role: "user", username: "slack:U_REV" });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(told()[0]).toMatchObject({ replace_original: true });
    expect(told()[0].text).toContain("*Approved* by @ana on *Orders*");
    await POST(signed(click("approval_reject")));
    expect(decide.mock.calls[1]?.[0]).toMatchObject({ decision: "reject" });
    expect(told()[1].text).toContain("*Rejected*");
  });

  // docs/CONTEXT.md §4.28: the first of two approvals is recorded and the presser told; the buttons stay.
  test("the first of two approvals is told as such, and the execution is not run", async () => {
    decide.mockImplementationOnce(
      async () => ({ ...pending, approvalsRequired: 2, approvals: [{ reviewer: "slack:U_REV", at: "x" }] }) as never,
    );
    settle.mockImplementationOnce(async (d: ApprovalRequest) => d);
    await POST(signed(click("approval_approve")));
    expect(told()[0]).toMatchObject({ response_type: "ephemeral" });
    expect(told()[0].text).toContain("1 of 2 approvals");
  });

  test("the asker, a non-reviewer, a decided request and a missing one are told so, ephemerally, and nothing is decided", async () => {
    await POST(signed(click("approval_approve", { id: "U_ASKER" })));
    expect(told()[0]).toMatchObject({ response_type: "ephemeral" });
    expect(told()[0].text).toContain("made for you");
    reviewerAllowed = false;
    await POST(signed(click("approval_approve")));
    expect(told()[1].text).toContain("not a reviewer");
    reviewerAllowed = true;
    record = { ...pending, status: "approved" };
    await POST(signed(click("approval_approve")));
    expect(told()[2].text).toContain("already approved");
    record = null;
    await POST(signed(click("approval_approve")));
    expect(told()[3].text).toContain("no longer exists");
    expect(decide).not.toHaveBeenCalled();
  });

  test("anything but the two buttons is acknowledged and ignored; a payload that is not JSON is a 400; the store's refusal keeps its status", async () => {
    expect((await POST(signed({ type: "view_submission" }))).status).toBe(200);
    expect((await POST(signed(click("something_else")))).status).toBe(200);
    expect((await POST(signed(click("approval_approve"), { body: "payload=%7Bnot-json" }))).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
    decide.mockImplementationOnce(async () => {
      throw new ApprovalError("You cannot review your own request", 403);
    });
    expect((await POST(signed(click("approval_approve")))).status).toBe(403);
    decide.mockImplementationOnce(async () => {
      throw new Error("store down");
    });
    expect((await POST(signed(click("approval_approve")))).status).toBe(500);
    // A broken audit sink never turns a refusal into a 500.
    audit.mockImplementationOnce(() => {
      throw new Error("sink");
    });
    expect((await POST(signed(click("approval_approve"), { signature: "v0=nope" }))).status).toBe(401);
  });
});
