import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";
import { mock } from "bun:test";

mock.module("@/lib/db-ui-config", () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const MockDBIcon = (props: Record<string, unknown>) =>
      React.createElement("span", { ...props, "data-testid": "db-icon" });
    MockDBIcon.displayName = "MockDBIcon";
    return MockDBIcon;
  },
  getDBConfig: () => ({ icon: () => null, color: "text-hue-blue", label: "PostgreSQL", defaultPort: "5432" }),
  getDBColor: () => "text-hue-blue",
}));

import { describe, test, expect, afterEach } from "bun:test";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";
import { ConnectionPicker } from "@/components/sidebar/ConnectionPicker";
import { mockPostgresConnection } from "../../fixtures/connections";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The sidebar's datasource row: it names what is open (engine icon, environment, read-only
 * badge), opens the grouped list, and closes on a choice.
 */
const prod: DatabaseConnection = {
  ...mockPostgresConnection,
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  environment: "production",
  managed: true,
  readOnly: true,
};
const dev: DatabaseConnection = {
  ...mockPostgresConnection,
  id: "seed:dev",
  seedId: "dev",
  name: "Dev shared",
  environment: "development",
  managed: true,
};

describe("ConnectionPicker", () => {
  afterEach(() => cleanup());

  test("names the open datasource with its environment and read-only badge, or asks for a choice", () => {
    const open = render(
      <ConnectionPicker connections={[prod, dev]} activeConnection={prod} onSelectConnection={mock(() => {})} />,
    );
    const trigger = open.getByTestId("connection-picker");
    expect(trigger.textContent).toContain("Orders");
    expect(trigger.textContent).toContain("PROD");
    expect(open.getByTestId("connection-picker-read-only")).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    open.unmount();

    const none = render(
      <ConnectionPicker connections={[prod, dev]} activeConnection={null} onSelectConnection={mock(() => {})} />,
    );
    expect(none.getByTestId("connection-picker").textContent).toContain("Choose a datasource");
    expect(none.queryByTestId("connection-picker-read-only")).toBeNull();
  });

  test("opens the grouped list, hands the choice over, and closes", async () => {
    const onSelect = mock(() => {});
    const { getByTestId, baseElement } = render(
      <ConnectionPicker connections={[prod, dev]} activeConnection={prod} onSelectConnection={onSelect} />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("connection-picker"));
    });
    expect(getByTestId("connection-picker").getAttribute("aria-expanded")).toBe("true");
    const item = baseElement.querySelector('[data-testid="connection-dev"]');
    expect(item).not.toBeNull();
    await act(async () => {
      fireEvent.click(item!);
    });
    expect(onSelect).toHaveBeenCalledWith(dev);
    expect(getByTestId("connection-picker").getAttribute("aria-expanded")).toBe("false");
  });

  test("the empty state's action closes the popover before it navigates", async () => {
    const onAdd = mock(() => {});
    const { getByTestId, baseElement } = render(
      <ConnectionPicker
        connections={[]}
        activeConnection={null}
        onSelectConnection={mock(() => {})}
        onAddConnection={onAdd}
      />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("connection-picker"));
    });
    const button = Array.from(baseElement.querySelectorAll("button")).find((b) => b.textContent === "New datasource");
    await act(async () => {
      fireEvent.click(button!);
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(getByTestId("connection-picker").getAttribute("aria-expanded")).toBe("false");
  });
});
