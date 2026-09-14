import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { AlertsPanel, draftToPayload, slugifyAlertId } from "@/components/alerts/AlertsPanel";

/**
 * The alerts panel (docs/CONTEXT.md §4.29): the list with each alert's state, the editor
 * that declares one from the datasources this session may open and the channels declared,
 * a run on demand with the state it lands in, and deletion.
 */
const managed = [
  { id: "seed:orders", seedId: "orders", name: "Orders", type: "postgres", createdAt: "2026-09-14T00:00:00.000Z" },
];
const channels = [
  { id: "ops", name: "Ops", kind: "slack" },
  { id: "hook", name: "Hook", kind: "webhook" },
];
const slow = {
  id: "slow-orders",
  name: "Slow orders",
  datasource: "orders",
  sql: "SELECT count(*) AS count FROM orders",
  op: ">",
  value: 100,
  everyMinutes: 5,
  cooldownMinutes: 60,
  channels: ["ops"],
  enabled: true,
  owner: { username: "ana", role: "user" },
  createdAt: "x",
  updatedAt: "x",
  state: { status: "firing", lastRunAt: new Date(Date.now() - 120_000).toISOString(), lastValue: "120" },
};
const broken = {
  ...slow,
  id: "broken",
  name: "Broken",
  op: "no_rows",
  value: undefined,
  enabled: false,
  state: { status: "error", lastError: "not_a_read" },
};
const stale = {
  ...slow,
  id: "stale",
  name: "Stale",
  state: { status: "ok", lastRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
};
const old = {
  ...slow,
  id: "old",
  name: "Old",
  state: { status: "ok", lastRunAt: new Date(Date.now() - 5 * 86_400_000).toISOString() },
};

function routes(over: Record<string, unknown> = {}) {
  return {
    "/api/connections/managed": { ok: true, json: { connections: managed } },
    "/api/channels": { ok: true, json: { channels } },
    ...over,
  } as Parameters<typeof mockGlobalFetch>[0];
}
async function renderLoaded() {
  const result = render(<AlertsPanel />);
  await waitFor(() => {
    if (result.queryByTestId("alerts-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("AlertsPanel", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists alerts with datasource name, condition, state and last run; an empty list and a failed read say so", async () => {
    mockGlobalFetch(routes({ "/api/alerts": { ok: true, json: { alerts: [slow, broken, stale, old] } } }));
    const { getByTestId } = await renderLoaded();
    await waitFor(() => {
      if (!within(getByTestId("alert-slow-orders")).queryByText("Orders")) throw new Error("datasource name not yet");
    });
    const row = within(getByTestId("alert-slow-orders"));
    expect(row.getByText("value is greater than 100")).not.toBeNull();
    expect(getByTestId("alert-slow-orders-status").textContent).toBe("firing");
    expect(row.getByText("2 min ago · 120")).not.toBeNull();
    expect(getByTestId("alert-broken-status").textContent).toBe("error: not_a_read");
    expect(within(getByTestId("alert-broken")).getByText(/paused/)).not.toBeNull();
    expect(within(getByTestId("alert-broken")).getByText("never")).not.toBeNull();
    expect(within(getByTestId("alert-stale")).getByText("3 h ago")).not.toBeNull();
    expect(within(getByTestId("alert-old")).getByText("5 d ago")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch(routes({ "/api/alerts": { ok: true, json: { alerts: [] } } }));
    expect((await renderLoaded()).getByTestId("alerts-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch(routes({ "/api/alerts": { ok: false, status: 503, json: { error: "no store" } } }));
    const { findByTestId } = render(<AlertsPanel />);
    expect((await findByTestId("alerts-error")).textContent).toContain("no store");
  });

  test("declaring posts the definition from the form - the id from the name, a numeric value as a number, the channels ticked; a blank form is refused first", async () => {
    const fetchMock = mockGlobalFetch(
      routes({
        "/api/alerts": (req: Request) =>
          req.method === "POST" ? { ok: true, status: 201, json: { alert: slow } } : { ok: true, json: { alerts: [] } },
      }),
    );
    const { getByText, getByLabelText, getByRole } = await renderLoaded();
    await waitFor(() => {
      if (!getByRole("button", { name: "New alert" })) throw new Error("not yet");
    });
    fireEvent.click(getByText("New alert"));
    fireEvent.click(getByText("Save alert"));
    expect(mockToastError).toHaveBeenCalledWith("A name, a datasource and a statement are required.");
    fireEvent.change(getByLabelText("Name"), { target: { value: "Slow orders" } });
    expect(getByText("id: slow-orders")).not.toBeNull();
    await waitFor(() => {
      if (!(getByLabelText("Datasource") as HTMLSelectElement).querySelector('option[value="orders"]'))
        throw new Error("datasources not yet");
    });
    fireEvent.change(getByLabelText("Datasource"), { target: { value: "orders" } });
    fireEvent.change(getByLabelText("Statement (a read)"), {
      target: { value: "SELECT count(*) AS count FROM orders" },
    });
    fireEvent.change(getByLabelText("Column (first when blank)"), { target: { value: "count" } });
    fireEvent.change(getByLabelText("Value"), { target: { value: "100" } });
    fireEvent.change(getByLabelText("Run every (minutes)"), { target: { value: "10" } });
    await waitFor(() => {
      if (!getByLabelText("Channel ops")) throw new Error("channels not yet");
    });
    fireEvent.click(getByLabelText("Channel ops"));
    fireEvent.click(getByLabelText("Channel hook"));
    fireEvent.click(getByLabelText("Channel hook"));
    await act(async () => {
      fireEvent.click(getByText("Save alert"));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string)).toEqual({
      id: "slow-orders",
      name: "Slow orders",
      datasource: "orders",
      sql: "SELECT count(*) AS count FROM orders",
      column: "count",
      op: ">",
      value: 100,
      everyMinutes: 10,
      cooldownMinutes: 60,
      channels: ["ops"],
      enabled: true,
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Alert "Slow orders" saved');
    // The pure mapping: a row-count operator carries no value; text stays text; an edit keeps the id.
    expect(
      draftToPayload(
        {
          id: "x",
          name: "N",
          datasource: "d",
          sql: "s",
          column: "",
          op: "no_rows",
          value: "9",
          everyMinutes: "1",
          cooldownMinutes: "0",
          channels: [],
          enabled: false,
        },
        false,
      ),
    ).toEqual({
      id: "x",
      name: "N",
      datasource: "d",
      sql: "s",
      op: "no_rows",
      everyMinutes: 1,
      cooldownMinutes: 0,
      channels: [],
      enabled: false,
    });
    expect(
      draftToPayload(
        {
          id: "kept",
          name: "N",
          datasource: "d",
          sql: "s",
          column: "",
          op: "==",
          value: "down",
          everyMinutes: "1",
          cooldownMinutes: "0",
          channels: [],
          enabled: true,
        },
        true,
      ),
    ).toMatchObject({ id: "kept", value: "down" });
    expect(slugifyAlertId("Órders > 100")).toBe("orders-100");
  });

  test("editing puts the alert's definition in the form and PUTs it; the server's refusal is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch(
      routes({
        "/api/alerts/slow-orders": (req: Request) =>
          req.method === "PUT"
            ? refuse
              ? { ok: false, status: 400, json: { error: "Only a statement that reads may be an alert" } }
              : { ok: true, json: { alert: slow } }
            : { ok: true, json: { deleted: "slow-orders" } },
        "/api/alerts": { ok: true, json: { alerts: [slow] } },
      }),
    );
    const { getByLabelText, getByText } = await renderLoaded();
    fireEvent.click(getByLabelText("Edit slow-orders"));
    expect((getByLabelText("Name") as HTMLInputElement).value).toBe("Slow orders");
    expect((getByLabelText("Value") as HTMLInputElement).value).toBe("100");
    fireEvent.change(getByLabelText("Condition"), { target: { value: "changed" } });
    expect((getByLabelText("Value") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(getByLabelText("Enabled"));
    await act(async () => {
      fireEvent.click(getByText("Save alert"));
    });
    const put = calls(fetchMock, "PUT")[0];
    expect(String(put[0])).toContain("/api/alerts/slow-orders");
    expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({
      id: "slow-orders",
      op: "changed",
      enabled: false,
    });
    expect(JSON.parse((put[1] as RequestInit).body as string).value).toBeUndefined();
    refuse = true;
    fireEvent.click(getByLabelText("Edit slow-orders"));
    await act(async () => {
      fireEvent.click(getByText("Save alert"));
    });
    expect(mockToastError).toHaveBeenLastCalledWith("Only a statement that reads may be an alert");
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    fireEvent.click(getByText("Refresh"));
  });

  test("running now reports the state it landed in; deleting asks first and shows a refusal", async () => {
    let state: Record<string, unknown> = { status: "ok", lastValue: "3" };
    let refuse = false;
    const fetchMock = mockGlobalFetch(
      routes({
        "/api/alerts/slow-orders/run": () =>
          refuse ? { ok: false, status: 500, json: { error: "boom" } } : { ok: true, json: { state } },
        "/api/alerts/slow-orders": () =>
          refuse
            ? { ok: false, status: 403, json: { error: "someone else's" } }
            : { ok: true, json: { deleted: "slow-orders" } },
        "/api/alerts": { ok: true, json: { alerts: [slow] } },
      }),
    );
    const { getByLabelText, getByRole, getByText, queryByText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByLabelText("Run slow-orders now"));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('"Slow orders" ran: ok (value 3)');
    state = { status: "error", lastError: "access" };
    await act(async () => {
      fireEvent.click(getByLabelText("Run slow-orders now"));
    });
    expect(mockToastError).toHaveBeenLastCalledWith('"Slow orders" failed: access');
    state = { status: "firing" };
    await act(async () => {
      fireEvent.click(getByLabelText("Run slow-orders now"));
    });
    expect(mockToastSuccess).toHaveBeenLastCalledWith('"Slow orders" ran: firing');
    fireEvent.click(getByLabelText("Delete slow-orders"));
    expect(getByText("Delete this alert?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Delete this alert?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("Delete slow-orders"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete alert" }));
    });
    expect(mockToastSuccess).toHaveBeenLastCalledWith('Alert "Slow orders" deleted');
    refuse = true;
    await act(async () => {
      fireEvent.click(getByLabelText("Run slow-orders now"));
    });
    expect(mockToastError).toHaveBeenLastCalledWith("boom");
    fireEvent.click(getByLabelText("Delete slow-orders"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete alert" }));
    });
    expect(mockToastError).toHaveBeenLastCalledWith("someone else's");
  });
});
