import "../setup-dom";
import "../helpers/mock-navigation";
import { mock } from "bun:test";
import React from "react";

// Mock MonitoringDashboard to avoid its massive dependency tree
mock.module("@/components/monitoring/MonitoringDashboard", () => ({
  MonitoringDashboard: () =>
    React.createElement("div", { "data-testid": "monitoring-dashboard" }, "MonitoringDashboard Mock"),
}));

const { default: MonitoringPage } = await import("@/app/monitoring/page");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { mockRouterPush } from "../helpers/mock-navigation";

/**
 * The studio's monitoring route: the admin shell's frame - a title bar with the way back to
 * the editor, then the page gutter - around the one dashboard, so it looks like the admin's
 * Monitoring section rather than a page of its own.
 */
describe("MonitoringPage", () => {
  afterEach(() => {
    cleanup();
    mockRouterPush.mockClear();
  });

  test("renders the dashboard inside the shell's gutter, under a title bar", () => {
    const { getByTestId, getByRole } = render(<MonitoringPage />);
    expect(getByTestId("monitoring-dashboard")).not.toBeNull();
    expect(getByTestId("monitoring-content").className).toContain("max-w-7xl");
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Database Monitoring");
  });

  test("the way back returns to the editor, and stays named when its text is hidden", () => {
    const { getByRole, getByText } = render(<MonitoringPage />);
    getByText("Editor").style.display = "none";
    fireEvent.click(getByRole("button", { name: "Back" }));
    expect(mockRouterPush).toHaveBeenCalledWith("/");
  });
});
