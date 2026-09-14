import "../../setup-dom";
import { describe, test, expect, mock, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { SlackChannelPicker } from "@/components/alerts/SlackChannelPicker";

/**
 * The Slack channel picker (docs/CONTEXT.md §4.29): the bot's list searched as one types,
 * the channel handed back on pick, and what the server refused said in the popover.
 */
const until = async (check: () => boolean) => {
  await waitFor(() => {
    if (!check()) throw new Error("not yet");
  });
};

describe("SlackChannelPicker", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists what the server answers for the query and hands the picked channel back", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/channels/slack": (req) => {
        const q = new URL(req.url).searchParams.get("q") ?? "";
        return {
          json: {
            channels: [
              { id: "C1", name: "general", private: false },
              { id: "C2", name: "ops-private", private: true },
            ].filter((c) => c.name.includes(q)),
          },
        };
      },
    });
    const onPick = mock((_c: unknown) => {});
    const view = render(<SlackChannelPicker onPick={onPick} />);
    fireEvent.click(view.getByTestId("slack-picker-open"));
    await until(() => view.queryByTestId("slack-option-C1") !== null);
    expect(view.queryByTestId("slack-option-C2")).not.toBeNull();
    const input = view.container.ownerDocument.querySelector("[cmdk-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ops" } });
    await until(() => view.queryByTestId("slack-option-C1") === null && view.queryByTestId("slack-option-C2") !== null);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("q=ops");
    fireEvent.click(view.getByTestId("slack-option-C2"));
    expect(onPick).toHaveBeenLastCalledWith({ id: "C2", name: "ops-private", private: true });
    await until(() => view.queryByTestId("slack-picker") === null);
  });

  test("says what the server refused, and when it could not be reached", async () => {
    mockGlobalFetch({
      "/api/channels/slack": { status: 503, json: { error: "Slack is not configured on the server" } },
    });
    const view = render(<SlackChannelPicker onPick={() => {}} />);
    fireEvent.click(view.getByTestId("slack-picker-open"));
    await until(() => view.queryByTestId("slack-picker-error") !== null);
    expect(view.getByTestId("slack-picker-error").textContent).toContain("not configured");
    cleanup();
    mockGlobalFetch({ "/api/channels/slack": { status: 502, text: "bad gateway" } });
    const second = render(<SlackChannelPicker onPick={() => {}} />);
    fireEvent.click(second.getByTestId("slack-picker-open"));
    await until(() => second.queryByTestId("slack-picker-error") !== null);
    expect(second.getByTestId("slack-picker-error").textContent).toBe("Slack channels could not be listed (502)");
    cleanup();
    globalThis.fetch = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const third = render(<SlackChannelPicker onPick={() => {}} />);
    fireEvent.click(third.getByTestId("slack-picker-open"));
    await until(() => third.queryByTestId("slack-picker-error") !== null);
    expect(third.getByTestId("slack-picker-error").textContent).toBe("Slack channels could not be listed");
  });
});
