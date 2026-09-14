import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { RunbooksPanel, parseParams, slugifyRunbookId } from "@/components/admin/RunbooksPanel";

/**
 * The operations page's runbooks panel (docs/CONTEXT.md §4.20): the runbooks of the
 * selected datasource, the sheet that declares one from a name, a statement and a
 * parameter list, and the delete; a seed-file runbook cannot be deleted here.
 */
const mine = {
  id: "customer-orders",
  name: "Orders of a customer",
  datasource: "orders",
  sql: "SELECT * FROM orders WHERE customer_id = {{customer_id}}",
  params: [
    { name: "customer_id", type: "number" },
    { name: "limit", type: "number", required: false },
  ],
  source: "store",
};
const seeded = { id: "seeded", name: "Seeded", datasource: "orders", sql: "SELECT 1", source: "config" };
const other = { id: "payroll", name: "Payroll", datasource: "hr", sql: "SELECT 1", source: "store" };
const listing = (runbooks: unknown[] = [mine, seeded, other]) => ({ ok: true, json: { runbooks } });

async function renderLoaded() {
  const result = render(<RunbooksPanel datasourceId="orders" datasourceName="Orders" />);
  await waitFor(() => {
    if (result.queryByTestId("runbooks-panel-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("RunbooksPanel", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists this datasource's runbooks with their parameters; a seed-file one has no delete button", async () => {
    mockGlobalFetch({ "/api/admin/runbooks": listing() });
    const { getByTestId, queryByTestId, getByText, getByLabelText, queryByLabelText } = await renderLoaded();
    expect(getByTestId("runbook-row-customer-orders")).not.toBeNull();
    expect(getByText("customer_id:number, limit:number?")).not.toBeNull();
    expect(getByLabelText("Delete Orders of a customer")).not.toBeNull();
    expect(getByText("seed file")).not.toBeNull();
    expect(queryByLabelText("Delete Seeded")).toBeNull();
    expect(queryByTestId("runbook-row-payroll")).toBeNull();
  });

  test("an empty list and a failed read each say so", async () => {
    mockGlobalFetch({ "/api/admin/runbooks": listing([other]) });
    const first = await renderLoaded();
    expect(first.getByTestId("runbooks-panel-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/runbooks": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<RunbooksPanel datasourceId="orders" datasourceName="Orders" />);
    expect((await findByTestId("runbooks-panel-error")).textContent).toContain("no store");
  });

  test("declaring posts the id from the name, the statement and the parsed parameters; a bad parameter line and a blank form are refused first", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/runbooks": (req) =>
        req.method === "POST" ? { ok: true, status: 201, json: { runbook: mine } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New runbook"));
    fireEvent.click(getByText("Declare runbook"));
    expect(mockToastError).toHaveBeenCalledWith("A name and a statement are required.");
    fireEvent.change(getByLabelText("Name"), { target: { value: "Orders of a customer" } });
    expect(getByText("id: orders-of-a-customer")).not.toBeNull();
    fireEvent.change(getByLabelText("Description (optional)"), { target: { value: "Open orders" } });
    fireEvent.change(getByLabelText("Statement"), {
      target: { value: "SELECT * FROM orders WHERE customer_id = {{customer_id}}" },
    });
    fireEvent.change(getByLabelText(/^Parameters/), {
      target: { value: "customer_id:number:Customer id\nlimit:number?\n" },
    });
    await act(async () => {
      fireEvent.click(getByText("Declare runbook"));
    });
    const body = JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      id: "orders-of-a-customer",
      name: "Orders of a customer",
      description: "Open orders",
      datasource: "orders",
      sql: "SELECT * FROM orders WHERE customer_id = {{customer_id}}",
      params: [
        { name: "customer_id", type: "number", label: "Customer id" },
        { name: "limit", type: "number", required: false },
      ],
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Runbook "Orders of a customer" declared');
    fireEvent.click(getByText("New runbook"));
    fireEvent.change(getByLabelText(/^Parameters/), { target: { value: "what" } });
    fireEvent.click(getByText("Declare runbook"));
    expect(mockToastError).toHaveBeenCalledWith('Cannot read parameter "what"');
  });

  test("the server's refusal of a declaration is shown in its words", async () => {
    mockGlobalFetch({
      "/api/admin/runbooks": (req) =>
        req.method === "POST" ? { ok: false, status: 409, json: { error: "already exists" } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New runbook"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "Dup" } });
    fireEvent.change(getByLabelText("Statement"), { target: { value: "SELECT 1" } });
    await act(async () => {
      fireEvent.click(getByText("Declare runbook"));
    });
    expect(mockToastError).toHaveBeenCalledWith("already exists");
  });

  test("deleting asks first, then sends the DELETE; a refusal is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/runbooks/customer-orders": () =>
        refuse
          ? { ok: false, status: 404, json: { error: "not found" } }
          : { ok: true, json: { deleted: "customer-orders" } },
      "/api/admin/runbooks": listing(),
    });
    const { getByLabelText, getByText, queryByText, getByRole } = await renderLoaded();
    fireEvent.click(getByLabelText("Delete Orders of a customer"));
    expect(getByText("Delete this runbook?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Delete this runbook?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("Delete Orders of a customer"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete runbook" }));
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Runbook "Orders of a customer" deleted');
    refuse = true;
    fireEvent.click(getByLabelText("Delete Orders of a customer"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete runbook" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("not found");
  });

  test("the helpers: the id shape and the parameter lines", () => {
    expect(slugifyRunbookId("Réindex (nightly)")).toBe("reindex-nightly");
    expect(parseParams("a:string\n b:number:With a: colon? \n\n")).toEqual({
      params: [
        { name: "a", type: "string" },
        { name: "b", type: "number", label: "With a: colon", required: false },
      ],
    });
    expect(parseParams("a:date").error).toBe('Cannot read parameter "a:date"');
    expect(parseParams(":number").error).toBe('Cannot read parameter ":number"');
  });
});
