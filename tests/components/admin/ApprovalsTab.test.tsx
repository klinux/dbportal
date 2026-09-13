import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
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
});
