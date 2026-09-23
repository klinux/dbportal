import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { ServiceTokensTab, listOf } from "@/components/admin/tabs/ServiceTokensTab";

/**
 * The service tokens page (docs/CONTEXT.md §4.10): the list with what each token may do,
 * the sheet that creates one and the secret shown exactly once after, and the revocation
 * that keeps the row.
 */
const live = {
  id: "tok-1",
  name: "slack-bot",
  role: "user",
  groups: ["sre"],
  datasources: ["orders"],
  requireApproval: true,
  trustedApprovals: true,
  prefix: "dbp_abcdef",
  createdAt: "2026-09-14T00:00:00.000Z",
  createdBy: "root",
  lastUsedAt: "2026-09-14T01:00:00.000Z",
};
const revoked = {
  ...live,
  id: "tok-0",
  name: "old-bot",
  requireApproval: false,
  trustedApprovals: false,
  revokedAt: "2026-09-13T00:00:00.000Z",
  revokedBy: "root",
  lastUsedAt: undefined,
};
const listing = (tokens: unknown[] = [live, revoked]) => ({ ok: true, json: { tokens } });

async function renderLoaded() {
  const result = render(<ServiceTokensTab />);
  await waitFor(() => {
    if (result.queryByTestId("service-tokens-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("ServiceTokensTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists every token with its actor name, prefix, access, review rule and last use; a revoked one has no revoke button", async () => {
    mockGlobalFetch({ "/api/admin/service-tokens": listing() });
    const { getByTestId } = await renderLoaded();
    const bot = within(getByTestId("service-token-tok-1"));
    expect(bot.getByText("svc:slack-bot")).not.toBeNull();
    expect(bot.getByText("dbp_abcdef…")).not.toBeNull();
    expect(bot.getByText("sre")).not.toBeNull();
    expect(bot.getByText("orders")).not.toBeNull();
    expect(bot.getByText("every request")).not.toBeNull();
    // A token that may declare its own approvers is marked, so an operator sees at a glance
    // which bots the portal trusts; one without the flag shows nothing.
    expect(bot.getByText("trusted approvals")).not.toBeNull();
    expect(bot.getByLabelText("Revoke slack-bot")).not.toBeNull();
    const old = within(getByTestId("service-token-tok-0"));
    expect(old.getByText("revoked")).not.toBeNull();
    expect(old.getByText("writes that need it")).not.toBeNull();
    expect(old.queryByText("trusted approvals")).toBeNull();
    expect(old.getByText("never")).not.toBeNull();
    expect(old.queryByLabelText("Revoke old-bot")).toBeNull();
  });

  test("an empty store says a bot needs one; a failed read is shown in the server's words", async () => {
    mockGlobalFetch({ "/api/admin/service-tokens": listing([]) });
    const first = await renderLoaded();
    expect(first.getByTestId("service-tokens-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/service-tokens": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<ServiceTokensTab />);
    expect((await findByTestId("service-tokens-error")).textContent).toContain("no store");
  });

  test("creating posts the fields as lists and shows the secret once, until dismissed", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/service-tokens": (req) =>
        req.method === "POST"
          ? { status: 201, ok: true, json: { token: live, secret: "dbp_the-secret-once" } }
          : listing([]),
    });
    const { getByText, getByLabelText, getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.click(getByText("New token"));
    expect(getByTestId("service-token-sheet")).not.toBeNull();
    fireEvent.change(getByLabelText("Name"), { target: { value: " slack-bot " } });
    fireEvent.change(getByLabelText("Role"), { target: { value: "admin" } });
    fireEvent.change(getByLabelText("Groups (comma-separated, optional)"), { target: { value: "sre, sre, ops" } });
    fireEvent.change(getByLabelText(/^Datasources/), { target: { value: "orders" } });
    await act(async () => {
      fireEvent.click(getByText("Create token"));
    });
    const [post] = calls(fetchMock, "POST");
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      name: "slack-bot",
      role: "admin",
      groups: ["sre", "ops"],
      datasources: ["orders"],
      requireApproval: true,
      trustedApprovals: false,
    });
    expect(getByTestId("service-token-secret").textContent).toContain("dbp_the-secret-once");
    fireEvent.click(getByText("Done"));
    expect(queryByTestId("service-token-secret")).toBeNull();
  });

  test("a blank name is refused before any request; the server's refusal is shown in its words", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/service-tokens": (req) =>
        req.method === "POST" ? { ok: false, status: 409, json: { error: "already exists" } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New token"));
    fireEvent.click(getByText("Create token"));
    expect(mockToastError).toHaveBeenCalledWith("Give the token a name.");
    expect(calls(fetchMock, "POST")).toHaveLength(0);
    fireEvent.change(getByLabelText("Name"), { target: { value: "dup" } });
    fireEvent.click(getByLabelText(/Every request waits/));
    // Ticking trusted approvals is what sends the flag; it is off unless the operator asks.
    fireEvent.click(getByLabelText(/Trusted approvals/));
    await act(async () => {
      fireEvent.click(getByText("Create token"));
    });
    const posted = JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string);
    expect(posted.requireApproval).toBe(false);
    expect(posted.trustedApprovals).toBe(true);
    expect(mockToastError).toHaveBeenCalledWith("already exists");
  });

  test("revoking asks first, then sends the DELETE and reloads; a refusal is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/service-tokens/tok-1": () =>
        refuse
          ? { ok: false, status: 409, json: { error: "already revoked" } }
          : { ok: true, json: { token: revoked } },
      "/api/admin/service-tokens": listing(),
    });
    const { getByLabelText, getByText, queryByText } = await renderLoaded();
    fireEvent.click(getByLabelText("Revoke slack-bot"));
    expect(getByText("Revoke service token?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Revoke service token?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("Revoke slack-bot"));
    await act(async () => {
      fireEvent.click(getByText("Revoke", { selector: "button" }));
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Service token "slack-bot" revoked');
    refuse = true;
    fireEvent.click(getByLabelText("Revoke slack-bot"));
    await act(async () => {
      fireEvent.click(getByText("Revoke", { selector: "button" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("already revoked");
  });

  test("the secret can be copied, and a clipboard that refuses is reported", async () => {
    mockGlobalFetch({
      "/api/admin/service-tokens": (req) =>
        req.method === "POST" ? { status: 201, ok: true, json: { token: live, secret: "dbp_s" } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New token"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "bot" } });
    await act(async () => {
      fireEvent.click(getByText("Create token"));
    });
    const clipboard = { writeText: async (_t: string) => {} };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    await act(async () => {
      fireEvent.click(getByText("Copy"));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Secret copied");
    clipboard.writeText = async () => {
      throw new Error("denied");
    };
    await act(async () => {
      fireEvent.click(getByText("Copy"));
    });
    expect(mockToastError).toHaveBeenCalledWith("Could not copy; select the secret and copy it by hand");
  });

  test("listOf splits, trims, drops blanks and duplicates", () => {
    expect(listOf(" a, b ,,a ")).toEqual(["a", "b"]);
    expect(listOf("")).toEqual([]);
  });
});
