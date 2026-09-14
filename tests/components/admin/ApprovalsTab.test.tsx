import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { ApprovalsTab } from "@/components/admin/tabs/ApprovalsTab";

/**
 * The reviewer's page (docs/CONTEXT.md §4.6): pending requests with their statements and
 * three window sizes to approve for, recent decisions, and the refusals shown in the
 * server's words.
 */
const pending = {
  id: "req-1",
  datasourceId: "orders",
  datasourceName: "Orders",
  requester: "ana",
  statement: "DELETE FROM orders WHERE id = 1",
  route: "POST /api/db/query",
  status: "pending",
  requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
};
const approved = {
  ...pending,
  id: "req-0",
  requester: "bob",
  status: "approved",
  reviewer: "root",
  reviewedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  windowUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const rejected = {
  ...pending,
  id: "req-2",
  requester: "cid",
  status: "rejected",
  reviewer: "root",
  reviewedAt: pending.requestedAt,
};

async function renderLoaded() {
  const result = render(<ApprovalsTab />);
  await waitFor(() => {
    if (result.queryByTestId("approvals-loading")) throw new Error("still loading");
  });
  return result;
}

describe("ApprovalsTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists pending requests with their statement and age, and recent decisions with their window", async () => {
    mockGlobalFetch({ "/api/approvals": { ok: true, json: { approvals: [pending, approved, rejected] } } });
    const { getByTestId, getByText } = await renderLoaded();
    expect(getByTestId("approval-req-1").textContent).toContain("DELETE FROM orders");
    expect(getByTestId("approval-req-1").textContent).toContain("3 min ago");
    expect(getByTestId("approval-req-0").textContent).toContain("open for 5 min");
    expect(getByTestId("approval-req-0").textContent).toContain("2 h ago");
    expect(getByTestId("approval-req-2").textContent).toContain("rejected");
    expect(getByText("Pending (1)")).not.toBeNull();
  });

  test("approving posts the decision with the chosen window and reloads", async () => {
    let decided = false;
    const fetchMock = mockGlobalFetch({
      "/api/approvals/req-1": (req) => {
        decided = req.method === "POST";
        return { ok: true, json: { approval: { ...pending, status: "approved" } } };
      },
      "/api/approvals": () => ({ ok: true, json: { approvals: decided ? [approved] : [pending] } }),
    });
    const { getByLabelText, queryByTestId } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByLabelText("Approve ana for 60 minutes"));
    });
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ decision: "approve", windowMinutes: 60 });
    await waitFor(() => {
      if (queryByTestId("approval-req-1")) throw new Error("still listed");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('ana may write on "Orders" for 60 min');
  });

  test("rejecting posts the decision without a window; a refused decision is shown in the server's words", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/approvals/req-1": (req) =>
        req.method === "POST"
          ? { ok: false, status: 403, json: { error: "You cannot review your own request" } }
          : { ok: true, json: {} },
      "/api/approvals": { ok: true, json: { approvals: [pending] } },
    });
    const { getByLabelText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByLabelText("Reject request from ana"));
    });
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ decision: "reject" });
    expect(mockToastError).toHaveBeenCalledWith("You cannot review your own request");
  });

  test("an empty list says so; a failed load is reported; refresh reloads", async () => {
    mockGlobalFetch({ "/api/approvals": { ok: true, json: { approvals: [] } } });
    const empty = await renderLoaded();
    expect(empty.getByTestId("approvals-empty")).not.toBeNull();
    empty.unmount();

    let calls = 0;
    mockGlobalFetch({
      "/api/approvals": () => {
        calls += 1;
        return calls === 1
          ? { ok: false, status: 500, json: { error: "x" } }
          : { ok: true, json: { approvals: [pending] } };
      },
    });
    const failed = render(<ApprovalsTab />);
    await waitFor(() => {
      if (!failed.queryByTestId("approvals-error")) throw new Error("no error yet");
    });
    expect(failed.getByTestId("approvals-error").textContent).toContain("500");
    await act(async () => {
      fireEvent.click(failed.getByText("Refresh"));
    });
    await waitFor(() => {
      if (!failed.queryByTestId("approval-req-1")) throw new Error("not reloaded");
    });
    expect(failed.queryByTestId("approvals-error")).toBeNull();
  });

  test("a rejection that goes through is confirmed and the list reloads", async () => {
    let decided = false;
    mockGlobalFetch({
      "/api/approvals/req-1": (req) => {
        decided = req.method === "POST";
        return { ok: true, json: { approval: rejected } };
      },
      "/api/approvals": () => ({ ok: true, json: { approvals: decided ? [rejected] : [pending] } }),
    });
    const { getByLabelText, queryByTestId } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByLabelText("Reject request from ana"));
    });
    await waitFor(() => {
      if (queryByTestId("approval-req-1")) throw new Error("still pending");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Request from ana rejected");
  });

  test("a rejection is reported even when the network fails", async () => {
    mockGlobalFetch({
      "/api/approvals/req-1": () => {
        throw new Error("offline");
      },
      "/api/approvals": { ok: true, json: { approvals: [pending] } },
    });
    const { getByLabelText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByLabelText("Reject request from ana"));
    });
    expect(mockToastError).toHaveBeenCalledWith("offline");
  });

  // docs/CONTEXT.md §4.10: a bot's request shows the person it is for, runs once on approval
  // (no window to size), and once decided says what the run did.
  test("an execution request names the person, offers Run now instead of windows, and reports its outcome", async () => {
    const queued = {
      ...pending,
      id: "exec-1",
      kind: "execution",
      requester: "svc:slack-bot",
      subject: "U0123",
      route: "POST /api/v1/executions",
    };
    const ran = {
      ...queued,
      id: "exec-0",
      status: "approved",
      reviewer: "root",
      reviewedAt: pending.requestedAt,
      execution: { status: "done", startedAt: "x", finishedAt: "y", durationMs: 12, rowCount: 3 },
    };
    const failed = {
      ...ran,
      id: "exec-2",
      execution: { status: "failed", startedAt: "x", finishedAt: "y", durationMs: 1, error: "query_error" },
    };
    const notRun = { ...ran, id: "exec-3", execution: undefined };
    let decided = false;
    const fetchMock = mockGlobalFetch({
      "/api/approvals/exec-1": (req) => {
        decided = req.method === "POST";
        return { ok: true, json: { approval: ran } };
      },
      "/api/approvals": () => ({
        ok: true,
        json: { approvals: decided ? [ran, failed, notRun] : [queued, ran, failed, notRun] },
      }),
    });
    const { getByTestId, getByLabelText, queryByLabelText, queryByTestId } = await renderLoaded();
    const row = within(getByTestId("approval-exec-1"));
    expect(row.getByText("U0123")).not.toBeNull();
    expect(row.getByText("via svc:slack-bot")).not.toBeNull();
    expect(queryByLabelText("Approve svc:slack-bot for 15 minutes")).toBeNull();
    expect(within(getByTestId("approval-exec-0")).getByText("3 rows in 12 ms")).not.toBeNull();
    expect(within(getByTestId("approval-exec-2")).getByText("failed: query_error")).not.toBeNull();
    expect(within(getByTestId("approval-exec-3")).getByText("not run")).not.toBeNull();

    await act(async () => {
      fireEvent.click(getByLabelText("Run request from U0123"));
    });
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ decision: "approve" });
    await waitFor(() => {
      if (queryByTestId("approval-exec-1")) throw new Error("still pending");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Ran on "Orders" for U0123');
  });

  // docs/CONTEXT.md §4.21: a statement longer than the fold shows its head, and the rest on request.
  test("a long statement is folded with a toggle that shows all of it", async () => {
    const long = `UPDATE orders SET status = 'x' WHERE id IN (${Array.from({ length: 500 }, (_, i) => i).join(", ")})`;
    mockGlobalFetch({ "/api/approvals": { ok: true, json: { approvals: [{ ...pending, statement: long }] } } });
    const { getByTestId } = await renderLoaded();
    const shown = getByTestId("statement-req-1");
    expect(shown.textContent).toBe(`${long.slice(0, 600)}…`);
    const toggle = getByTestId("statement-toggle-req-1");
    expect(toggle.textContent).toBe(`Show all (${long.length.toLocaleString()} characters)`);
    fireEvent.click(toggle);
    expect(getByTestId("statement-req-1").textContent).toBe(long);
    expect(getByTestId("statement-toggle-req-1").textContent).toBe("Show less");
  });

  test("a short statement is shown whole, with no toggle", async () => {
    mockGlobalFetch({ "/api/approvals": { ok: true, json: { approvals: [pending] } } });
    const { getByTestId, queryByTestId } = await renderLoaded();
    expect(getByTestId("statement-req-1").textContent).toBe(pending.statement);
    expect(queryByTestId("statement-toggle-req-1")).toBeNull();
  });

  // docs/CONTEXT.md §4.18: the reviewer sees the change the request is for.
  test("a request that named a ticket shows it under the statement", async () => {
    mockGlobalFetch({ "/api/approvals": { ok: true, json: { approvals: [{ ...pending, ticket: "INC-42" }] } } });
    const { getByTestId } = await renderLoaded();
    expect(getByTestId("ticket-req-1").textContent).toBe("ticket INC-42");
  });

  // docs/CONTEXT.md §4.15: the reviewer sees why a statement waits when a guardrail held it.
  test("a request held by a guardrail is badged with the guardrail's name", async () => {
    mockGlobalFetch({
      "/api/approvals": { ok: true, json: { approvals: [{ ...pending, guardrail: "delete_without_where" }] } },
    });
    const { getByTestId } = await renderLoaded();
    expect(within(getByTestId("approval-req-1")).getByText("guardrail: DELETE without WHERE")).not.toBeNull();
  });
});
