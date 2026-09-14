import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { TrailAlertsCard } from "@/components/admin/TrailAlertsCard";

/** The trail alerts card (docs/CONTEXT.md §4.32): the rules' channels ticked, the export threshold, and one save. */
const channels = [
  { id: "ops", name: "Ops" },
  { id: "hook", name: "Hook" },
];
const stored = {
  rules: { guardrail: ["ops"], production_export: [], backup_failed: [], seed_failed: [] },
  exportRowsThreshold: 1000,
};
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("TrailAlertsCard", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("shows what is stored, ticks and unticks channels per rule, refuses a bad threshold first, and PUTs the document", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/trail-alerts": (req) =>
        req.method === "PUT"
          ? refuse
            ? { ok: false, status: 503, json: { error: "no store" } }
            : { ok: true, json: { trailAlerts: stored } }
          : { ok: true, json: { trailAlerts: stored } },
    });
    const { getByLabelText, getByText, queryByTestId } = render(<TrailAlertsCard channels={channels} />);
    await waitFor(() => {
      if (queryByTestId("trail-alerts-loading")) throw new Error("still loading");
    });
    expect((getByLabelText("A guardrail fired: ops") as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText("A guardrail fired: hook") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(getByLabelText("A guardrail fired: ops"));
    fireEvent.click(getByLabelText("A large export left production: hook"));
    fireEvent.change(getByLabelText("Rows that make an export large"), { target: { value: "0" } });
    fireEvent.click(getByText("Save trail alerts"));
    expect(mockToastError).toHaveBeenCalledWith("The export threshold must be a whole number of rows, at least 1.");
    fireEvent.change(getByLabelText("Rows that make an export large"), { target: { value: "250" } });
    await act(async () => {
      fireEvent.click(getByText("Save trail alerts"));
    });
    expect(JSON.parse((calls(fetchMock, "PUT")[0][1] as RequestInit).body as string)).toEqual({
      rules: { guardrail: [], production_export: ["hook"], backup_failed: [], seed_failed: [] },
      exportRowsThreshold: 250,
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Trail alerts saved");
    refuse = true;
    await act(async () => {
      fireEvent.click(getByText("Save trail alerts"));
    });
    expect(mockToastError).toHaveBeenLastCalledWith("no store");
  });

  test("says when the rules could not be loaded, and when no channel is declared", async () => {
    mockGlobalFetch({ "/api/admin/trail-alerts": { ok: false, status: 503, json: { error: "no store" } } });
    render(<TrailAlertsCard channels={[]} />);
    await waitFor(() => {
      if (!mockToastError.mock.calls.length) throw new Error("not yet");
    });
    expect(mockToastError).toHaveBeenCalledWith("no store");
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/trail-alerts": { ok: true, json: { trailAlerts: stored } } });
    const { findAllByText } = render(<TrailAlertsCard channels={[]} />);
    // One note per rule, since the rules are listed even with nothing to tick.
    expect(await findAllByText("No channel declared yet.")).toHaveLength(4);
  });
});
