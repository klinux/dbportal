import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { EnvironmentsTab, slugifyEnvironmentId } from "@/components/admin/tabs/EnvironmentsTab";

/**
 * The environments page (docs/CONTEXT.md §4.36): the list with each one's source, the sheet
 * that declares or relabels one, and the delete offered only for a stored one that is not
 * production.
 */
const builtin = { id: "production", label: "PROD", color: "#ef4444", order: 0, source: "builtin" };
const qa = { id: "qa", label: "QA", color: "#abcdef", order: 2, source: "store" };
const listing = (environments: unknown[] = [builtin, qa]) => ({ ok: true, json: { environments } });

async function renderLoaded() {
  const result = render(<EnvironmentsTab />);
  await waitFor(() => {
    if (result.queryByTestId("environments-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("EnvironmentsTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists environments with their source; only a stored non-production one can be deleted; a failed read says so", async () => {
    mockGlobalFetch({ "/api/admin/environments": listing() });
    const { getByTestId } = await renderLoaded();
    const prod = within(getByTestId("environment-production"));
    expect(prod.getByText("built-in")).not.toBeNull();
    expect(prod.queryByLabelText("Delete production")).toBeNull();
    expect(prod.getByLabelText("Edit production")).not.toBeNull();
    const row = within(getByTestId("environment-qa"));
    expect(row.getByText("declared")).not.toBeNull();
    expect(row.getByLabelText("Delete qa")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/environments": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<EnvironmentsTab />);
    expect((await findByTestId("environments-error")).textContent).toContain("no store");
  });

  test("declaring posts the id from the label, the colour and the order; editing keeps the id; a blank form is refused first", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/environments": (req) =>
        req.method === "POST" ? { ok: true, status: 201, json: { environment: qa } } : listing(),
    });
    const { getByText, getByLabelText, getByTestId } = await renderLoaded();
    fireEvent.click(getByText("New environment"));
    fireEvent.click(getByText("Save environment"));
    expect(mockToastError).toHaveBeenCalledWith("A label, an id and a whole-number order are required.");
    fireEvent.change(getByLabelText("Label"), { target: { value: "Quality Assurance" } });
    expect(getByText("id: quality-assurance")).not.toBeNull();
    fireEvent.change(getByLabelText("Order"), { target: { value: "7" } });
    await act(async () => {
      fireEvent.click(getByText("Save environment"));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string)).toEqual({
      id: "quality-assurance",
      label: "Quality Assurance",
      color: "#6b7280",
      order: 7,
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Environment "Quality Assurance" saved');
    fireEvent.click(within(getByTestId("environment-production")).getByLabelText("Edit production"));
    fireEvent.change(getByLabelText("Label"), { target: { value: "PRD" } });
    await act(async () => {
      fireEvent.click(getByText("Save environment"));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[1][1] as RequestInit).body as string)).toMatchObject({
      id: "production",
      label: "PRD",
    });
    fireEvent.click(getByText("Refresh"));
  });

  test("the server's refusal is shown in its words; deleting asks first and shows a refusal", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/environments/qa": () =>
        refuse ? { ok: false, status: 409, json: { error: "still used" } } : { ok: true, json: { deleted: "qa" } },
      "/api/admin/environments": (req) =>
        req.method === "POST" ? { ok: false, status: 400, json: { error: "bad colour" } } : listing(),
    });
    const { getByText, getByLabelText, getByRole, queryByText } = await renderLoaded();
    fireEvent.click(getByText("New environment"));
    fireEvent.change(getByLabelText("Label"), { target: { value: "X" } });
    await act(async () => {
      fireEvent.click(getByText("Save environment"));
    });
    expect(mockToastError).toHaveBeenCalledWith("bad colour");
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    fireEvent.click(getByLabelText("Delete qa"));
    expect(getByText("Delete this environment?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Delete this environment?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("Delete qa"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete environment" }));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Environment "QA" deleted');
    refuse = true;
    fireEvent.click(getByLabelText("Delete qa"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete environment" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("still used");
    expect(slugifyEnvironmentId("Pré-Prod (EU)")).toBe("pre-prod-eu");
  });
});
