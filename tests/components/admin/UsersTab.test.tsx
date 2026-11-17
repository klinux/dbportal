import "../../setup-dom";
import { describe, test, expect, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { GROUPS_SHOWN, UsersTab, sinceLabel } from "@/components/admin/tabs/UsersTab";

/**
 * The Users page (docs/CONTEXT.md §4.60): who has signed in, newest first, with what their
 * last sign-in carried and how often they come - and the plain answers for a deployment
 * without a store, an empty one, a filter that matches nobody, and counts that are a floor.
 */
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const ana = {
  username: "ana@example.test",
  firstSeenAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt: new Date(NOW - 3 * 3_600_000).toISOString(),
  role: "admin",
  groups: ["sre", "dba", "payments", "on-call"],
  method: "oidc",
  signIns: 12,
};
const bob = {
  username: "bob@example.test",
  firstSeenAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-10-01T00:00:00.000Z",
  role: "user",
  method: "password",
  signIns: 0,
};
// Remembered before §4.60: nothing but the dates, and counts the audit record could not give.
const old = { username: "old@example.test", firstSeenAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-02T00:00:00.000Z", signIns: null };
const listing = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: { available: true, users: [ana, bob, old], windowDays: 30, countsCapped: false, ...over },
});

async function renderLoaded() {
  const result = render(<UsersTab />);
  await waitFor(() => {
    if (result.queryByTestId("users-loading")) throw new Error("still loading");
  });
  return result;
}

describe("UsersTab", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("the last sign-in reads coarsely: within the hour, hours, then days", () => {
    expect(sinceLabel(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("within the hour");
    // A clock a little behind the server's never reads as the future.
    expect(sinceLabel(new Date(NOW + 60_000).toISOString(), NOW)).toBe("within the hour");
    expect(sinceLabel(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago");
    expect(sinceLabel(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe("2d ago");
  });

  test("lists each person with method, role, groups folded past a few, dates and sign-ins", async () => {
    mockGlobalFetch({ "/api/admin/users": listing() });
    const { getByTestId } = await renderLoaded();
    expect(getByTestId("users-count").textContent).toBe("3 of 3");

    const a = within(getByTestId("user-row-ana@example.test"));
    expect(a.getByText("SSO")).not.toBeNull();
    expect(a.getByText("Administrator")).not.toBeNull();
    for (const group of ana.groups.slice(0, GROUPS_SHOWN)) expect(a.getByText(group)).not.toBeNull();
    expect(a.queryByText("on-call")).toBeNull();
    expect(a.getByText(`+${ana.groups.length - GROUPS_SHOWN}`)).not.toBeNull();
    expect(a.getByText("12")).not.toBeNull();

    const b = within(getByTestId("user-row-bob@example.test"));
    expect(b.getByText("password")).not.toBeNull();
    expect(b.getByText("User")).not.toBeNull();
    expect(b.getByText("0")).not.toBeNull();

    // No role yet and no count: dashes, never a guess.
    const o = within(getByTestId("user-row-old@example.test"));
    expect(o.getAllByText("—")).toHaveLength(2);
    expect(o.queryByText("SSO")).toBeNull();
  });

  test("the filter matches user, role or group, says how many, and says when nobody matches", async () => {
    mockGlobalFetch({ "/api/admin/users": listing() });
    const { getByLabelText, getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.change(getByLabelText("Filter users"), { target: { value: "PAYMENTS" } });
    expect(getByTestId("users-count").textContent).toBe("1 of 3");
    expect(queryByTestId("user-row-bob@example.test")).toBeNull();
    fireEvent.change(getByLabelText("Filter users"), { target: { value: "user" } });
    expect(getByTestId("users-count").textContent).toBe("1 of 3");
    expect(getByTestId("user-row-bob@example.test")).not.toBeNull();
    fireEvent.change(getByLabelText("Filter users"), { target: { value: "nobody-here" } });
    expect(getByTestId("users-empty").textContent).toBe("No user matches the filter.");
  });

  test("an empty deployment, a capped window, and a refresh that reads again", async () => {
    let users: unknown[] = [];
    const fetchMock = mockGlobalFetch({ "/api/admin/users": () => listing({ users, countsCapped: true }) });
    const { getByTestId, getByText } = await renderLoaded();
    expect(getByTestId("users-empty").textContent).toBe("Nobody has signed in yet.");
    expect(getByTestId("users-capped")).not.toBeNull();
    users = [ana];
    fireEvent.click(getByText("Refresh"));
    await waitFor(() => {
      if (!document.querySelector('[data-testid="user-row-ana@example.test"]')) throw new Error("not yet");
    });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("without a server store the page explains instead of listing; a failed read shows the error", async () => {
    mockGlobalFetch({ "/api/admin/users": listing({ available: false, users: [] }) });
    const first = await renderLoaded();
    expect(first.getByTestId("users-unavailable").textContent).toContain("STORAGE_PROVIDER=local");
    expect(first.queryByLabelText("Filter users")).toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/users": { ok: false, status: 403, json: { error: "Admin only" } } });
    const second = render(<UsersTab />);
    expect((await second.findByTestId("users-error")).textContent).toContain("Admin only");
    cleanup();
    restoreGlobalFetch();
    // A refusal without a body still names its status.
    mockGlobalFetch({ "/api/admin/users": { ok: false, status: 502, json: {} } });
    const third = render(<UsersTab />);
    expect((await third.findByTestId("users-error")).textContent).toContain("HTTP 502");
  });
});
