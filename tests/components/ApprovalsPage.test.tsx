import "../setup-dom";
import "../helpers/mock-navigation";
import { mock } from "bun:test";
import React from "react";

// The approvals section itself is covered in tests/components/admin/ApprovalsTab.test.tsx.
mock.module("@/components/admin/tabs/ApprovalsTab", () => ({
  ApprovalsTab: () => React.createElement("div", { "data-testid": "approvals-tab" }, "ApprovalsTab Mock"),
}));

const { default: ApprovalsPage } = await import("@/app/approvals/page");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { mockRouterPush } from "../helpers/mock-navigation";

/**
 * The reviewer's page (docs/CONTEXT.md §4.19): the admin's approvals section inside the
 * studio's shell, reachable by anyone signed in, because a reviewer need not administer.
 */
describe("ApprovalsPage", () => {
  afterEach(() => {
    cleanup();
    mockRouterPush.mockClear();
  });

  test("renders the approvals section inside the shell's gutter, under a title bar", () => {
    const { getByTestId, getByRole } = render(<ApprovalsPage />);
    expect(getByTestId("approvals-tab")).not.toBeNull();
    expect(getByTestId("approvals-content").className).toContain("max-w-7xl");
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Approvals");
  });

  test("the way back returns to the editor", () => {
    const { getByRole } = render(<ApprovalsPage />);
    fireEvent.click(getByRole("button", { name: "Back" }));
    expect(mockRouterPush).toHaveBeenCalledWith("/");
  });
});
