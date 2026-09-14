import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";
import { mock } from "bun:test";

// Mock db-ui-config: the icon per engine is a marker, not the SVG.
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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { ConnectionsList, groupByEnvironment } from "@/components/sidebar/ConnectionsList";
import { mockPostgresConnection, mockMySQLConnection } from "../../fixtures/connections";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The grouped datasource list (docs/CONTEXT.md §4.1: every row is a managed datasource):
 * environments in the admin page's order, one item per datasource with its engine icon and
 * its badges, a search box once the list is long enough to need one, and the two empty states.
 */
const conn = (over: Partial<DatabaseConnection>): DatabaseConnection => ({
  ...mockPostgresConnection,
  managed: true,
  ...over,
});
const prod = conn({ id: "seed:orders", seedId: "orders", name: "Orders", environment: "production", readOnly: true });
const staging = conn({ id: "seed:orders-stg", seedId: "orders-stg", name: "Orders (staging)", environment: "staging" });
const dev = conn({ id: "seed:dev", seedId: "dev", name: "Dev shared", environment: "development" });
const bare = conn({ id: "seed:bare", seedId: "bare", name: "Unlabelled", environment: undefined });

describe("groupByEnvironment", () => {
  test("orders production first and files a missing environment under Other, keeping declaration order inside a group", () => {
    const groups = groupByEnvironment([
      bare,
      dev,
      staging,
      prod,
      conn({ id: "seed:dev2", seedId: "dev2", name: "Dev two", environment: "development" }),
    ]);
    expect(groups.map((g) => g.env)).toEqual(["production", "staging", "development", "other"]);
    expect(groups.map((g) => g.label)).toEqual(["PROD", "STAGING", "DEV", "Other"]);
    expect(groups[2].connections.map((c) => c.name)).toEqual(["Dev shared", "Dev two"]);
    expect(groupByEnvironment([])).toEqual([]);
  });
});

describe("ConnectionsList", () => {
  let onSelect: ReturnType<typeof mock>;
  let onAdd: ReturnType<typeof mock>;

  beforeEach(() => {
    onSelect = mock(() => {});
    onAdd = mock(() => {});
  });
  afterEach(() => cleanup());

  test("renders one group per environment, in order, with the engine icon and badges per datasource", () => {
    const { getByTestId, getAllByTestId, container } = render(
      <ConnectionsList connections={[dev, prod, staging]} activeConnection={prod} onSelectConnection={onSelect} />,
    );
    const headings = Array.from(container.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent);
    expect(headings).toEqual(["PROD", "STAGING", "DEV"]);
    expect(getByTestId("connections-group-production").textContent).toContain("Orders");
    expect(getAllByTestId("db-icon")).toHaveLength(3);
    expect(getByTestId("read-only-orders")).not.toBeNull();
    expect(getByTestId("managed-lock-orders")).not.toBeNull();
    expect(getByTestId("connection-orders").getAttribute("data-active")).toBe("true");
    expect(getByTestId("connection-dev").getAttribute("data-active")).toBe("false");
  });

  test("selecting an item hands the connection over", () => {
    const { getByTestId } = render(
      <ConnectionsList connections={[prod, dev]} activeConnection={null} onSelectConnection={onSelect} />,
    );
    fireEvent.click(getByTestId("connection-dev"));
    expect(onSelect).toHaveBeenCalledWith(dev);
  });

  // The box is always there (requested 2026-09-14): a fleet has many datasources.
  test("the search box narrows the groups, and is there for a short list too", () => {
    const short = render(
      <ConnectionsList
        connections={[conn({ id: "seed:one", seedId: "one" })]}
        activeConnection={null}
        onSelectConnection={onSelect}
      />,
    );
    expect(short.container.querySelector("[cmdk-input]")).not.toBeNull();
    short.unmount();
    const many = Array.from({ length: 6 }, (_, i) =>
      conn({
        id: `seed:c${i}`,
        seedId: `c${i}`,
        name: i === 0 ? "Billing" : `Store ${i}`,
        environment: i % 2 ? "staging" : "development",
      }),
    );
    const { container, queryByTestId } = render(
      <ConnectionsList connections={many} activeConnection={null} onSelectConnection={onSelect} autoFocus />,
    );
    const input = container.querySelector("[cmdk-input]") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "billing" } });
    expect(queryByTestId("connection-c0")).not.toBeNull();
    expect(queryByTestId("connection-c1")).toBeNull();
    fireEvent.change(input, { target: { value: "nothing-like-this" } });
    expect(container.querySelector("[cmdk-empty]")?.textContent).toContain("No datasource matches");
  });

  test("with nothing to list, an administrator is offered the datasource page and anyone else a hint", () => {
    const admin = render(
      <ConnectionsList
        connections={[]}
        activeConnection={null}
        onSelectConnection={onSelect}
        onAddConnection={onAdd}
      />,
    );
    fireEvent.click(admin.getByText("New datasource"));
    expect(onAdd).toHaveBeenCalledTimes(1);
    admin.unmount();
    const user = render(<ConnectionsList connections={[]} activeConnection={null} onSelectConnection={onSelect} />);
    expect(user.getByTestId("connections-empty").textContent).toContain("Ask an administrator");
  });

  test("a mixed list still renders the older fixtures", () => {
    const { getByText } = render(
      <ConnectionsList
        connections={[mockPostgresConnection, mockMySQLConnection]}
        activeConnection={null}
        onSelectConnection={onSelect}
      />,
    );
    expect(getByText("Test PostgreSQL")).not.toBeNull();
    expect(getByText("Test MySQL")).not.toBeNull();
  });
});
