import "../../setup-dom";
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { ApprovalState } from "@/components/studio/ApprovalState";

/**
 * The tab's waiting state (docs/CONTEXT.md §4.6, §4.15): the three outcomes in words, and
 * the guardrail's name when that is why the statement waits.
 */
const base = {
  id: "req-1",
  status: "pending" as const,
  datasourceId: "orders",
  datasourceName: "Orders",
  requestedAt: "2026-09-14T00:00:00.000Z",
};

describe("ApprovalState", () => {
  afterEach(() => {
    cleanup();
  });

  test("pending says a reviewer is needed, and names the guardrail when one held the statement", () => {
    const plain = render(<ApprovalState approval={base} />);
    expect(plain.getByText("Awaiting approval")).not.toBeNull();
    expect(plain.queryByTestId("approval-guardrail")).toBeNull();
    cleanup();
    const held = render(<ApprovalState approval={{ ...base, guardrail: "delete_without_where" }} />);
    expect(held.getByTestId("approval-guardrail").textContent).toContain("DELETE without WHERE");
    cleanup();
    // A guardrail this build does not label is shown as its code rather than blank.
    const unknown = render(<ApprovalState approval={{ ...base, guardrail: "later_rule" }} />);
    expect(unknown.getByTestId("approval-guardrail").textContent).toContain("later_rule");
  });

  test("approved names the reviewer and the window; rejected names the reviewer", () => {
    const approved = render(
      <ApprovalState
        approval={{ ...base, status: "approved", reviewer: "root", windowUntil: "2026-09-14T01:00:00.000Z" }}
      />,
    );
    expect(approved.getByText("Write approved")).not.toBeNull();
    expect(approved.getByText(/root opened a write window/)).not.toBeNull();
    cleanup();
    const rejected = render(<ApprovalState approval={{ ...base, status: "rejected", reviewer: "root" }} />);
    expect(rejected.getByText("Write rejected")).not.toBeNull();
    cleanup();
    // docs/CONTEXT.md §4.28: nobody decided in time; running again asks again.
    const expired = render(<ApprovalState approval={{ ...base, status: "expired" }} />);
    expect(expired.getByTestId("approval-state-expired")).not.toBeNull();
    expect(expired.getByText(/run the statement again to ask again/)).not.toBeNull();
  });
});
