import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// ── Mock MonitoringDashboard to capture props ───────────────────────────────

let capturedProps: Record<string, unknown> | null = null;

mock.module("@/components/monitoring/MonitoringDashboard", () => ({
  MonitoringDashboard: (props: Record<string, unknown>) => {
    capturedProps = props;
    return React.createElement("div", { "data-testid": "monitoring-dashboard" }, "MonitoringDashboard");
  },
}));

// ── Import after mock ───────────────────────────────────────────────────────
// Dynamic import so it is not hoisted above the mock.module() call: a static
// import would evaluate the real MonitoringDashboard (and every monitoring tab
// it imports), poisoning coverage with all-zero records for those files.

const { MonitoringEmbed } = await import("@/components/admin/tabs/MonitoringEmbed");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MonitoringEmbed", () => {
  afterEach(() => {
    cleanup();
    capturedProps = null;
  });

  // The admin page provides the gutter and the dashboard its own section header, so the
  // embed is a plain wrapper: no fixed height, no padding of its own to double the page's.
  test("renders MonitoringDashboard in a plain wrapper that adds no height or padding", () => {
    const { queryByTestId, container } = render(<MonitoringEmbed />);
    expect(queryByTestId("monitoring-dashboard")).not.toBeNull();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-testid")).toBe("monitoring-embed-root");
    expect(wrapper.className).not.toContain("h-full");
    expect(wrapper.className).not.toMatch(/\bp-\d/);
  });

  test("passes isEmbedded=true to MonitoringDashboard", () => {
    render(<MonitoringEmbed />);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.isEmbedded).toBe(true);
  });

  test("does not pass any other props to MonitoringDashboard", () => {
    render(<MonitoringEmbed />);
    expect(capturedProps).not.toBeNull();
    const keys = Object.keys(capturedProps!);
    expect(keys).toEqual(["isEmbedded"]);
  });

  test("renders MonitoringDashboard text content", () => {
    const { queryByText } = render(<MonitoringEmbed />);
    expect(queryByText("MonitoringDashboard")).not.toBeNull();
  });
});
