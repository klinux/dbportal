import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { ChannelsTab, slugifyChannelId } from "@/components/admin/tabs/ChannelsTab";

/**
 * The channels page (docs/CONTEXT.md §4.29): the list with each one's source, the sheet
 * that declares one, a test message from the list, and the delete offered for a stored one.
 */
const ops = { id: "ops", name: "Ops", kind: "slack", target: "C0123", source: "config" };
const hook = { id: "hook", name: "Hook", kind: "webhook", target: "https://h.test/x", source: "store" };
const listing = (channels: unknown[] = [ops, hook]) => ({ ok: true, json: { channels } });

async function renderLoaded() {
  const result = render(<ChannelsTab />);
  await waitFor(() => {
    if (result.queryByTestId("channels-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("ChannelsTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists channels with source and kind; only a stored one can be deleted; an empty list and a failed read say so", async () => {
    mockGlobalFetch({ "/api/admin/channels": listing() });
    const { getByTestId } = await renderLoaded();
    const slack = within(getByTestId("channel-ops"));
    expect(slack.getByText("seed file")).not.toBeNull();
    expect(slack.getByText("Slack channel")).not.toBeNull();
    expect(slack.queryByLabelText("Delete ops")).toBeNull();
    expect(slack.getByLabelText("Send a test to ops")).not.toBeNull();
    expect(within(getByTestId("channel-hook")).getByLabelText("Delete hook")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/channels": listing([]) });
    const empty = await renderLoaded();
    expect(empty.getByTestId("channels-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/channels": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<ChannelsTab />);
    expect((await findByTestId("channels-error")).textContent).toContain("no store");
  });

  test("declaring posts the id from the name, the kind and the target; a blank form is refused first; the server's refusal is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/channels": (req) =>
        req.method === "POST"
          ? refuse
            ? { ok: false, status: 400, json: { error: "target must be https" } }
            : { ok: true, status: 201, json: { channel: hook } }
          : listing(),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New channel"));
    fireEvent.click(getByText("Save channel"));
    expect(mockToastError).toHaveBeenCalledWith("A name, an id and a target are required.");
    fireEvent.change(getByLabelText("Name"), { target: { value: "Ops on-call" } });
    expect(getByText("id: ops-on-call")).not.toBeNull();
    fireEvent.change(getByLabelText("Kind"), { target: { value: "rootly" } });
    fireEvent.change(getByLabelText("URL"), { target: { value: "https://rootly.test/hook " } });
    await act(async () => {
      fireEvent.click(getByText("Save channel"));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string)).toEqual({
      id: "ops-on-call",
      name: "Ops on-call",
      kind: "rootly",
      target: "https://rootly.test/hook",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Channel "Ops on-call" saved');
    refuse = true;
    fireEvent.click(getByText("New channel"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.change(getByLabelText("Channel id"), { target: { value: "C9" } });
    await act(async () => {
      fireEvent.click(getByText("Save channel"));
    });
    expect(mockToastError).toHaveBeenCalledWith("target must be https");
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    fireEvent.click(getByText("Refresh"));
    expect(slugifyChannelId("Ops (EU) #1")).toBe("ops-eu-1");
  });

  test("a test message reports delivered or not; deleting asks first and shows a refusal", async () => {
    let delivered = true;
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/channels/hook/test": () => ({ ok: true, json: { delivered } }),
      "/api/admin/channels/ops/test": { ok: false, status: 404, json: { error: "not found" } },
      "/api/admin/channels/hook": () =>
        refuse ? { ok: false, status: 409, json: { error: "still used" } } : { ok: true, json: { deleted: "hook" } },
      "/api/admin/channels": listing(),
    });
    const { getByLabelText, getByRole, getByText, queryByText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByLabelText("Send a test to hook"));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Test message delivered to "Hook"');
    delivered = false;
    await act(async () => {
      fireEvent.click(getByLabelText("Send a test to hook"));
    });
    expect(mockToastError).toHaveBeenLastCalledWith('"Hook" did not take the test message; see the server log');
    await act(async () => {
      fireEvent.click(getByLabelText("Send a test to ops"));
    });
    expect(mockToastError).toHaveBeenLastCalledWith("not found");
    fireEvent.click(getByLabelText("Delete hook"));
    expect(getByText("Delete this channel?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Delete this channel?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("Delete hook"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete channel" }));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Channel "Hook" deleted');
    refuse = true;
    fireEvent.click(getByLabelText("Delete hook"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete channel" }));
    });
    expect(mockToastError).toHaveBeenLastCalledWith("still used");
  });

  // docs/CONTEXT.md §4.29 (asked 2026-09-14): beside the alerts, for anyone signed in.
  test("in the user scope the list comes from the session route without targets, only one's own can be deleted, and a Slack channel is picked by name", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/channels/slack": { json: { channels: [{ id: "C77", name: "ops-alerts", private: false }] } },
      "/api/channels": (req) =>
        req.method === "POST"
          ? {
              ok: true,
              status: 201,
              json: { channel: { id: "ops-alerts", name: "#ops-alerts", kind: "slack", createdBy: "ana" } },
            }
          : {
              ok: true,
              json: {
                channels: [
                  { id: "ops", name: "Ops", kind: "slack" },
                  { id: "mine", name: "Mine", kind: "webhook", createdBy: "ana" },
                  { id: "bobs", name: "Bob's", kind: "rootly", createdBy: "bob" },
                ],
              },
            },
    });
    const view = render(<ChannelsTab scope="user" username="ana" />);
    await waitFor(() => {
      if (view.queryByTestId("channels-loading")) throw new Error("still loading");
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/channels");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/api/admin/");
    expect(view.getByText("Declared by")).not.toBeNull();
    expect(within(view.getByTestId("channel-ops")).getByText("seed file")).not.toBeNull();
    expect(within(view.getByTestId("channel-bobs")).getByText("bob")).not.toBeNull();
    expect(view.queryByLabelText("Delete ops")).toBeNull();
    expect(view.queryByLabelText("Delete bobs")).toBeNull();
    expect(view.getByLabelText("Delete mine")).not.toBeNull();
    fireEvent.click(view.getByText("New channel"));
    fireEvent.click(view.getByTestId("slack-picker-open"));
    await waitFor(() => {
      if (!view.queryByTestId("slack-option-C77")) throw new Error("not yet");
    });
    fireEvent.click(view.getByTestId("slack-option-C77"));
    expect((view.getByLabelText("Channel id") as HTMLInputElement).value).toBe("C77");
    expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("#ops-alerts");
    await act(async () => {
      fireEvent.click(view.getByText("Save channel"));
    });
    const post = calls(fetchMock, "POST")[0];
    expect(String(post[0])).toMatch(/\/api\/channels$/);
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      id: "ops-alerts",
      name: "#ops-alerts",
      kind: "slack",
      target: "C77",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Channel "#ops-alerts" saved');
  });
});
