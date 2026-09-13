import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The admin page for shared datasources (docs/CONTEXT.md §4.1 step B). The connection modal
 * is replaced by a stub that hands its props out, because what this page adds is what
 * travels AROUND the modal - the roles, the id, the secret note, the request the save
 * becomes - and tests/components/ConnectionModal.test.tsx owns the form itself.
 */
let capturedModalProps: Record<string, unknown> = {};
mock.module("@/components/ConnectionModal", () => ({
  ConnectionModal: (props: Record<string, unknown>) => {
    capturedModalProps = props;
    if (!props.isOpen) return null;
    const heading = props.heading as { title: string; description: string };
    return React.createElement(
      "div",
      { "data-testid": "connection-modal" },
      React.createElement("h2", null, heading.title),
      React.createElement("p", null, heading.description),
      React.createElement("span", { "data-testid": "submit-label" }, String(props.submitLabel)),
      props.extraFields as React.ReactNode,
    );
  },
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, waitFor, act, cleanup, fireEvent, within } from "@testing-library/react";

const { DatasourcesTab, slugifyDatasourceId, toDatasourcePayload } = await import(
  "@/components/admin/tabs/DatasourcesTab"
);

const storeRow = {
  source: "store",
  id: "prod-orders",
  name: "Orders",
  type: "postgres",
  host: "orders.internal",
  port: 5432,
  database: "orders",
  user: "portal",
  environment: "production",
  roles: ["user"],
  hasPassword: true,
  passwordEnv: "ORDERS_PASS",
  hasConnectionString: false,
  updatedAt: "2026-09-13T00:00:00.000Z",
  updatedBy: "root@example.test",
};
const configRow = {
  source: "config",
  id: "dev-shared",
  name: "Dev shared",
  type: "postgres",
  environment: "development",
  roles: ["*"],
};

function listing(overrides: Partial<{ available: boolean; datasources: unknown[]; declared: unknown[] }> = {}) {
  return { ok: true, json: { available: true, datasources: [storeRow], declared: [configRow], ...overrides } };
}

const built: DatabaseConnection = {
  id: "ignored-by-the-page",
  name: "Reporting réplica",
  type: "postgres",
  host: "reports.internal",
  port: 5432,
  database: "reports",
  user: "ro",
  password: "${REPORTS_PASS}",
  environment: "staging",
  createdAt: new Date(0),
};

async function renderLoaded() {
  const result = render(<DatasourcesTab />);
  await waitFor(() => expect(result.queryByTestId("datasources-loading")).toBeNull());
  return result;
}

describe("DatasourcesTab", () => {
  beforeEach(() => {
    capturedModalProps = {};
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("groups every shared datasource by environment, production first, and marks the seed-file ones read-only", async () => {
    mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByTestId, container } = await renderLoaded();

    const sections = [...container.querySelectorAll("section")].map((s) => s.getAttribute("data-testid"));
    expect(sections).toEqual(["env-group-production", "env-group-development"]);

    const orders = within(getByTestId("datasource-row-prod-orders"));
    expect(orders.getByText("Users")).not.toBeNull();
    expect(orders.getByText("orders.internal:5432/orders")).not.toBeNull();
    expect(orders.getByLabelText("Edit Orders")).not.toBeNull();
    expect(orders.getByLabelText("Delete Orders")).not.toBeNull();

    const dev = within(getByTestId("datasource-row-dev-shared"));
    expect(dev.getByText("seed file")).not.toBeNull();
    expect(dev.getByText("read-only")).not.toBeNull();
    // `roles: ["*"]` reads as both roles, the way the server applies it.
    expect(dev.getByText("Administrators")).not.toBeNull();
    expect(dev.getByText("Users")).not.toBeNull();
  });

  // STORAGE_PROVIDER=local has no server store: the page says what to set and offers no
  // create button, but still lists what the seed file declares.
  test("without server storage it explains what to set and disables creation", async () => {
    mockGlobalFetch({ "/api/admin/datasources": listing({ available: false, datasources: [] }) });
    const { getByRole, getByText } = await renderLoaded();
    expect(getByRole("status").textContent).toContain("STORAGE_PROVIDER");
    expect((getByText("New datasource").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Dev shared")).not.toBeNull();
  });

  test("a failed load is reported, not swallowed", async () => {
    mockGlobalFetch({ "/api/admin/datasources": { ok: false, status: 500, json: { error: "storage down" } } });
    await renderLoaded();
    expect(mockToastError).toHaveBeenCalledWith("Could not load datasources: storage down");
  });

  // The save is what the modal hands back after its own connection test, plus what this page
  // adds: the roles ticked and an id derived from the name.
  test("creating posts the modal's connection with the roles ticked and a slug id, then reloads", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByText, getByTestId, getByLabelText } = await renderLoaded();

    fireEvent.click(getByText("New datasource"));
    expect(getByTestId("connection-modal")).not.toBeNull();
    expect(getByText("New datasource", { selector: "h2" })).not.toBeNull();
    expect(getByTestId("submit-label").textContent).toBe("Create datasource");
    expect(getByTestId("datasource-secret-note").textContent).toContain("${ENV_VAR}");

    // Users only: untick administrators.
    fireEvent.click(getByLabelText("Administrators"));

    await act(async () => {
      await (capturedModalProps.onConnect as (c: DatabaseConnection) => Promise<void>)(built);
    });

    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(String(post[0])).toContain("/api/admin/datasources");
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.id).toBe("reporting-replica");
    expect(body.roles).toEqual(["user"]);
    expect(body.password).toBe("${REPORTS_PASS}");
    expect(body.environment).toBe("staging");
    expect(mockToastSuccess).toHaveBeenCalledWith('Datasource "Reporting réplica" created');
    expect(capturedModalProps.isOpen).toBe(false);
    // Reloaded after the save: the initial GET and one more.
    expect(fetchMock.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method).length).toBe(2);
  });

  test("a datasource nobody may open is refused before anything is sent", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New datasource"));
    fireEvent.click(getByLabelText("Administrators"));
    fireEvent.click(getByLabelText("Users"));
    await act(async () => {
      await (capturedModalProps.onConnect as (c: DatabaseConnection) => Promise<void>)(built);
    });
    expect(mockToastError).toHaveBeenCalledWith("Choose at least one role that may open this datasource.");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  test("a name with nothing to slug is refused", async () => {
    mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByText } = await renderLoaded();
    fireEvent.click(getByText("New datasource"));
    await act(async () => {
      await (capturedModalProps.onConnect as (c: DatabaseConnection) => Promise<void>)({ ...built, name: "***" });
    });
    expect(mockToastError).toHaveBeenCalledWith("The name must contain at least one letter or digit.");
  });

  test("the server's refusal is shown in its own words", async () => {
    mockGlobalFetch({
      "/api/admin/datasources": (req) =>
        req.method === "POST"
          ? { ok: false, status: 409, json: { error: 'A datasource with id "reporting-replica" already exists' } }
          : listing(),
    });
    const { getByText } = await renderLoaded();
    fireEvent.click(getByText("New datasource"));
    await act(async () => {
      await (capturedModalProps.onConnect as (c: DatabaseConnection) => Promise<void>)(built);
    });
    expect(mockToastError).toHaveBeenCalledWith(
      'Could not save datasource: A datasource with id "reporting-replica" already exists',
    );
    expect(capturedModalProps.isOpen).toBe(true);
  });

  // Editing round-trips the view, which carries no secret: the form opens with a blank
  // password, says what the server holds, and the save goes to the record's own id.
  test("editing opens the stored datasource without its secret and PUTs to its id", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByLabelText, getByTestId, getByText } = await renderLoaded();

    fireEvent.click(getByLabelText("Edit Orders"));
    const edit = capturedModalProps.editConnection as DatabaseConnection;
    expect(edit.id).toBe("prod-orders");
    expect(edit.password).toBe("");
    expect(edit.managed).toBe(true);
    expect(getByText("Edit datasource", { selector: "h2" })).not.toBeNull();
    expect(getByTestId("submit-label").textContent).toBe("Save datasource");
    expect(getByTestId("datasource-secret-note").textContent).toContain("${ORDERS_PASS}");
    // The roles come from the record, not from the create default.
    expect((getByLabelText("Administrators") as HTMLButtonElement).getAttribute("data-state")).toBe("unchecked");
    expect((getByLabelText("Users") as HTMLButtonElement).getAttribute("data-state")).toBe("checked");

    await act(async () => {
      await (capturedModalProps.onConnect as (c: DatabaseConnection) => Promise<void>)({
        ...built,
        name: "Orders v2",
        password: "",
      });
    });
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT")!;
    expect(String(put[0])).toContain("/api/admin/datasources/prod-orders");
    const body = JSON.parse((put[1] as RequestInit).body as string);
    expect(body.id).toBe("prod-orders");
    expect(body.name).toBe("Orders v2");
    expect(body.roles).toEqual(["user"]);
    expect(mockToastSuccess).toHaveBeenCalledWith('Datasource "Orders v2" updated');
  });

  test("the secret note distinguishes a stored value from no credential", async () => {
    mockGlobalFetch({
      "/api/admin/datasources": listing({
        datasources: [
          { ...storeRow, id: "a", name: "A", passwordEnv: undefined, hasPassword: true },
          { ...storeRow, id: "b", name: "B", passwordEnv: undefined, hasPassword: false },
        ],
      }),
    });
    const { getByLabelText, getByTestId } = await renderLoaded();
    fireEvent.click(getByLabelText("Edit A"));
    expect(getByTestId("datasource-secret-note").textContent).toContain("never shown here");
    fireEvent.click(getByLabelText("Edit B"));
    expect(getByTestId("datasource-secret-note").textContent).toContain("No credential is stored yet.");
  });

  test("deleting asks first, then DELETEs by id and reloads", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByLabelText, getByText, queryByText } = await renderLoaded();

    fireEvent.click(getByLabelText("Delete Orders"));
    expect(getByText("Delete datasource?")).not.toBeNull();
    fireEvent.click(getByText("Cancel"));
    await waitFor(() => expect(queryByText("Delete datasource?")).toBeNull());
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(getByLabelText("Delete Orders"));
    await act(async () => {
      fireEvent.click(getByText("Delete", { selector: "button" }));
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Datasource "Orders" deleted'));
    const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")!;
    expect(String(del[0])).toContain("/api/admin/datasources/prod-orders");
  });

  test("a failed delete is reported and the dialog closes", async () => {
    mockGlobalFetch({
      "/api/admin/datasources": (req) =>
        req.method === "DELETE" ? { ok: false, status: 503, json: { error: "no store" } } : listing(),
    });
    const { getByLabelText, getByText, queryByText } = await renderLoaded();
    fireEvent.click(getByLabelText("Delete Orders"));
    await act(async () => {
      fireEvent.click(getByText("Delete", { selector: "button" }));
    });
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Could not delete datasource: no store"));
    await waitFor(() => expect(queryByText("Delete datasource?")).toBeNull());
  });

  test("an empty list says so, in the words that fit the store's availability", async () => {
    mockGlobalFetch({ "/api/admin/datasources": listing({ datasources: [], declared: [] }) });
    const { getByText } = await renderLoaded();
    expect(getByText(/Create the first one/)).not.toBeNull();
  });

  test("a store row without a host shows no target", async () => {
    mockGlobalFetch({
      "/api/admin/datasources": listing({
        datasources: [
          { ...storeRow, id: "f", name: "File", type: "sqlite", host: undefined, port: undefined, database: undefined },
        ],
        declared: [],
      }),
    });
    const { getByTestId } = await renderLoaded();
    expect(within(getByTestId("datasource-row-f")).getByText("—")).not.toBeNull();
  });

  test("the refresh button reloads", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/datasources": listing() });
    const { getByText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByText("Refresh"));
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
  });
});

describe("datasource helpers", () => {
  test("slugifyDatasourceId produces the seed schema's id shape", () => {
    expect(slugifyDatasourceId("Orders (production)")).toBe("orders-production");
    expect(slugifyDatasourceId("  Réplica de leitura #2 ")).toBe("replica-de-leitura-2");
    expect(slugifyDatasourceId("***")).toBe("");
    expect(slugifyDatasourceId("x".repeat(80))).toHaveLength(64);
  });

  test("toDatasourcePayload carries the connection fields the seed schema knows, and nothing else", () => {
    const payload = toDatasourcePayload({ ...built, color: "#123456", sshTunnel: { enabled: true } as never }, "id-1", [
      "admin",
    ]);
    expect(payload).toMatchObject({ id: "id-1", roles: ["admin"], name: built.name, password: "${REPORTS_PASS}" });
    expect(payload).not.toHaveProperty("sshTunnel");
    expect(payload).not.toHaveProperty("createdAt");
  });
});
