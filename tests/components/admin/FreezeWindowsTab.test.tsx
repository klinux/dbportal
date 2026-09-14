import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { FreezeWindowsTab, slugifyFreezeId, stateOf, toInstant } from "@/components/admin/tabs/FreezeWindowsTab";

/**
 * The freeze windows page (docs/CONTEXT.md §4.17): the list with each window's state and
 * scope, the sheet that declares one from a reason and two local times, and the delete
 * that ends one; a seed-file window cannot be ended here.
 */
const inAnHour = new Date(Date.now() + 3600_000).toISOString();
const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
const active = {
  id: "release-42",
  reason: "Release 42 deploy",
  from: anHourAgo,
  until: inAnHour,
  source: "store",
  createdBy: "root",
};
const past = {
  id: "old",
  reason: "Old one",
  from: twoHoursAgo,
  until: anHourAgo,
  datasources: ["orders"],
  source: "config",
};
const listing = (windows: unknown[] = [active, past]) => ({ ok: true, json: { windows } });

async function renderLoaded() {
  const result = render(<FreezeWindowsTab />);
  await waitFor(() => {
    if (result.queryByTestId("freeze-windows-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("FreezeWindowsTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists windows with state and scope; a seed-file window has no end button", async () => {
    mockGlobalFetch({ "/api/admin/freezes": listing() });
    const { getByTestId } = await renderLoaded();
    const row = within(getByTestId("freeze-release-42"));
    expect(row.getByText("active")).not.toBeNull();
    expect(row.getByText("every datasource")).not.toBeNull();
    expect(row.getByLabelText("End Release 42 deploy")).not.toBeNull();
    const old = within(getByTestId("freeze-old"));
    expect(old.getByText("past")).not.toBeNull();
    expect(old.getByText("orders")).not.toBeNull();
    expect(old.getByText("seed file")).not.toBeNull();
    expect(old.queryByLabelText("End Old one")).toBeNull();
  });

  test("an empty list and a failed read each say so", async () => {
    mockGlobalFetch({ "/api/admin/freezes": listing([]) });
    const first = await renderLoaded();
    expect(first.getByTestId("freeze-windows-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/freezes": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<FreezeWindowsTab />);
    expect((await findByTestId("freeze-windows-error")).textContent).toContain("no store");
  });

  test("declaring posts the id from the reason, the instants, and the datasources; a blank form is refused first", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/freezes": (req) =>
        req.method === "POST" ? { ok: true, status: 201, json: { window: active } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New window"));
    fireEvent.click(getByText("Declare window"));
    expect(mockToastError).toHaveBeenCalledWith("A reason, a start and an end are required.");
    fireEvent.change(getByLabelText("Reason"), { target: { value: "Release 42 (EU)" } });
    expect(getByText("id: release-42-eu")).not.toBeNull();
    fireEvent.change(getByLabelText("From"), { target: { value: "2026-09-14T09:00" } });
    fireEvent.change(getByLabelText("Until"), { target: { value: "2026-09-14T12:00" } });
    fireEvent.change(getByLabelText(/^Datasources/), { target: { value: "orders, billing, orders" } });
    await act(async () => {
      fireEvent.click(getByText("Declare window"));
    });
    const body = JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ id: "release-42-eu", reason: "Release 42 (EU)", datasources: ["orders", "billing"] });
    expect(body.from).toBe(toInstant("2026-09-14T09:00"));
    expect(body.until).toBe(toInstant("2026-09-14T12:00"));
    expect(mockToastSuccess).toHaveBeenCalledWith('Freeze window "Release 42 (EU)" declared');
  });

  test("the server's refusal of a declaration is shown in its words", async () => {
    mockGlobalFetch({
      "/api/admin/freezes": (req) =>
        req.method === "POST" ? { ok: false, status: 409, json: { error: "already exists" } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New window"));
    fireEvent.change(getByLabelText("Reason"), { target: { value: "Dup" } });
    fireEvent.change(getByLabelText("From"), { target: { value: "2026-09-14T09:00" } });
    fireEvent.change(getByLabelText("Until"), { target: { value: "2026-09-14T12:00" } });
    await act(async () => {
      fireEvent.click(getByText("Declare window"));
    });
    expect(mockToastError).toHaveBeenCalledWith("already exists");
  });

  test("ending asks first, then sends the DELETE; a refusal is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/freezes/release-42": () =>
        refuse
          ? { ok: false, status: 404, json: { error: "not found" } }
          : { ok: true, json: { deleted: "release-42" } },
      "/api/admin/freezes": listing(),
    });
    const { getByLabelText, getByText, queryByText, getByRole } = await renderLoaded();
    fireEvent.click(getByLabelText("End Release 42 deploy"));
    expect(getByText("End this freeze window?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("End this freeze window?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("End Release 42 deploy"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "End window" }));
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Freeze window "Release 42 deploy" ended');
    refuse = true;
    fireEvent.click(getByLabelText("End Release 42 deploy"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "End window" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("not found");
    fireEvent.click(getByText("Refresh"));
  });

  test("the helpers: the id shape, the instant, and the state", () => {
    expect(slugifyFreezeId("Peak day (Black Friday)")).toBe("peak-day-black-friday");
    expect(toInstant("nonsense")).toBeNull();
    const now = Date.now();
    expect(stateOf({ from: new Date(now + 1000).toISOString(), until: new Date(now + 2000).toISOString() }, now)).toBe(
      "upcoming",
    );
    expect(stateOf({ from: new Date(now - 2000).toISOString(), until: new Date(now - 1000).toISOString() }, now)).toBe(
      "past",
    );
    expect(stateOf({ from: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString() }, now)).toBe(
      "active",
    );
  });
});
