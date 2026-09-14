import "../../setup-dom";
import { describe, test, expect, mock, afterEach } from "bun:test";
import React from "react";

/** The alerts area (docs/CONTEXT.md §4.29): the alerts on one tab, the channels a person may declare on the next. */
let channelsProps: Record<string, unknown> | null = null;
mock.module("@/components/alerts/AlertsPanel", () => ({
  AlertsPanel: () => React.createElement("div", { "data-testid": "alerts-panel-stub" }),
}));
mock.module("@/components/admin/tabs/ChannelsTab", () => ({
  ChannelsTab: (props: Record<string, unknown>) => {
    channelsProps = props;
    return React.createElement("div", { "data-testid": "channels-tab-stub" });
  },
}));
const { render, fireEvent, cleanup } = await import("@testing-library/react");
const { AlertsArea } = await import("@/components/alerts/AlertsArea");

describe("AlertsArea", () => {
  afterEach(cleanup);

  test("opens on the alerts; the Channels tab mounts the user-scoped channels with the person's name", () => {
    const { getByTestId, queryByTestId } = render(<AlertsArea username="ana" />);
    expect(getByTestId("alerts-panel-stub")).not.toBeNull();
    expect(queryByTestId("channels-tab-stub")).toBeNull();
    // Radix tabs switch on pointer down in happy-dom.
    fireEvent.mouseDown(getByTestId("alerts-tab-channels"), { button: 0 });
    expect(getByTestId("channels-tab-stub")).not.toBeNull();
    expect(channelsProps).toEqual({ scope: "user", username: "ana" });
  });
});
