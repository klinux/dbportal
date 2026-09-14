import "../setup-dom";
import { mockToastError } from "../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { Runbooks } from "@/components/Runbooks";

/**
 * The studio's runbooks view (docs/CONTEXT.md §4.20): the list for the open datasource,
 * the form for what a runbook asks for, and the run - the server's prepared statement
 * handed up with its values, or its refusal shown in its words.
 */
const lookup = {
  id: "customer-orders",
  name: "Orders of a customer",
  description: "Open orders of one customer",
  datasource: "orders",
  sql: "SELECT * FROM orders WHERE customer_id = {{customer_id}} AND archived = {{archived}} LIMIT {{limit}}",
  params: [
    { name: "customer_id", type: "number", label: "Customer" },
    { name: "archived", type: "boolean" },
    { name: "limit", type: "number", required: false, default: 50 },
  ],
};
const elsewhere = { id: "payroll", name: "Payroll", datasource: "hr", sql: "SELECT 1" };
const listing = (runbooks: unknown[] = [lookup, elsewhere]) => ({ ok: true, json: { runbooks } });

async function renderLoaded(props: Partial<React.ComponentProps<typeof Runbooks>> = {}) {
  const onRun = mock(() => {});
  const result = render(<Runbooks datasourceId="orders" onRun={onRun} {...props} />);
  await waitFor(() => {
    if (result.queryByTestId("runbooks-loading")) throw new Error("still loading");
  });
  return { ...result, onRun };
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("Runbooks", () => {
  beforeEach(() => {
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists the runbooks of the open datasource only; says so without a datasource, when there is none, and when the read fails", async () => {
    mockGlobalFetch({ "/api/runbooks": listing() });
    const first = await renderLoaded();
    expect(first.getByTestId("runbook-customer-orders")).not.toBeNull();
    expect(first.queryByTestId("runbook-payroll")).toBeNull();
    cleanup();
    const none = await renderLoaded({ datasourceId: "billing" });
    expect(none.getByTestId("runbooks-empty")).not.toBeNull();
    cleanup();
    const noDatasource = await renderLoaded({ datasourceId: undefined });
    expect(noDatasource.getByTestId("runbooks-no-datasource")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/runbooks": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<Runbooks datasourceId="orders" onRun={() => {}} />);
    expect((await findByTestId("runbooks-error")).textContent).toContain("no store");
  });

  test("the form starts from the defaults, posts the values, and hands the prepared statement up", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/runbooks/customer-orders/prepare": {
        ok: true,
        json: { runbook: "customer-orders", datasource: "orders", sql: "SELECT $1, $2, $3", params: [42, true, 50] },
      },
      "/api/runbooks": listing(),
    });
    const { getByTestId, getByLabelText, getByText, onRun } = await renderLoaded();
    fireEvent.click(getByTestId("runbook-customer-orders"));
    expect((getByLabelText("limit") as HTMLInputElement).value).toBe("50");
    fireEvent.change(getByLabelText("Customer *"), { target: { value: "42" } });
    fireEvent.change(getByLabelText("archived *"), { target: { value: "true" } });
    await act(async () => {
      fireEvent.click(getByText("Run"));
    });
    const body = JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string);
    expect(body).toEqual({ values: { customer_id: "42", archived: "true", limit: "50" } });
    expect(onRun).toHaveBeenCalledWith({
      sql: "SELECT $1, $2, $3",
      params: [42, true, 50],
      runbook: "customer-orders",
    });
    fireEvent.click(getByText("Refresh"));
  });

  test("the server's refusal is shown in its words and nothing runs; cancel closes the form", async () => {
    mockGlobalFetch({
      "/api/runbooks/customer-orders/prepare": { ok: false, status: 400, json: { error: '"Customer" is required' } },
      "/api/runbooks": listing(),
    });
    const { getByTestId, getByText, queryByTestId, onRun } = await renderLoaded();
    fireEvent.click(getByTestId("runbook-customer-orders"));
    await act(async () => {
      fireEvent.click(getByText("Run"));
    });
    expect(mockToastError).toHaveBeenCalledWith('"Customer" is required');
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(getByText("Cancel"));
    await waitFor(() => {
      if (queryByTestId("runbook-dialog")) throw new Error("still open");
    });
  });
});
