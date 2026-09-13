import "../setup-dom";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import type { QueryTab } from "@/lib/types";

/**
 * The client half of write approval (docs/CONTEXT.md §4.6): the windows this person holds
 * are read once, a waiting tab is polled until decided, and the decision reaches the tab,
 * the windows and a toast. Vault of state: nothing polls when nothing waits.
 */
const mockToast = mock((_opts: Record<string, unknown>) => {});
mock.module("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

const { useWriteApprovals, CLOSED_WINDOW_GRACE_MS } = await import("@/hooks/use-write-approvals");

const tab = (approval?: QueryTab["approval"]): QueryTab => ({
  id: "tab-1",
  name: "Query 1",
  query: "DELETE FROM t",
  result: null,
  isExecuting: false,
  type: "sql",
  ...(approval ? { approval } : {}),
});
const pending = {
  id: "req-1",
  status: "pending" as const,
  datasourceId: "orders",
  datasourceName: "Orders",
  requestedAt: "2026-09-13T00:00:00.000Z",
};

describe("useWriteApprovals", () => {
  beforeEach(() => mockToast.mockClear());
  afterEach(() => restoreGlobalFetch());

  test("reads the windows this person already holds once, and answers them by datasource id", async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const fetchMock = mockGlobalFetch({
      "/api/approvals": {
        ok: true,
        json: {
          approvals: [
            { ...pending, id: "old", status: "approved", reviewer: "root", windowUntil: until },
            {
              ...pending,
              id: "closed",
              datasourceId: "other",
              status: "approved",
              reviewer: "root",
              windowUntil: until,
            },
            { ...pending, id: "no", datasourceId: "rejected", status: "rejected", reviewer: "root" },
            // Older and closed, listed after the open one for the same datasource (measured
            // 2026-09-13: this overwrote the open window and the chip never showed).
            {
              ...pending,
              id: "older",
              status: "approved",
              reviewer: "root",
              windowUntil: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
        },
      },
    });
    const { result } = renderHook(() => useWriteApprovals({ tabs: [tab()], setTabs: mock(() => {}) }));
    await waitFor(() => {
      if (!result.current.windowFor("orders")) throw new Error("not yet");
    });
    expect(result.current.windowFor("orders")).toEqual({ until, reviewer: "root" });
    expect(result.current.windowFor("other")).toEqual({ until, reviewer: "root" });
    expect(result.current.windowFor("rejected")).toBeNull();
    expect(result.current.windowFor(undefined)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("scope=mine");
  });

  test("polls a waiting request until it is decided, then updates the tab, the windows and the toast", async () => {
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    let polls = 0;
    mockGlobalFetch({
      "/api/approvals/req-1": () => {
        polls += 1;
        return {
          ok: true,
          json: {
            approval: polls < 2 ? pending : { ...pending, status: "approved", reviewer: "root", windowUntil: until },
          },
        };
      },
      "/api/approvals": { ok: true, json: { approvals: [] } },
    });
    // A second tab that waits on nothing must come through the update untouched.
    let tabs = [tab(pending), { ...tab(), id: "tab-2" }];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs = fn(tabs);
    });
    const { result, rerender } = renderHook(
      ({ current }: { current: QueryTab[] }) => useWriteApprovals({ tabs: current, setTabs, pollMs: 15 }),
      { initialProps: { current: tabs } },
    );
    await waitFor(() => {
      if (!result.current.windowFor("orders")) throw new Error("not yet");
    });
    expect(tabs[0].approval).toMatchObject({ status: "approved", reviewer: "root", windowUntil: until });
    expect(tabs[1]).not.toHaveProperty("approval");
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Write approved" }));
    // Decided: the tab no longer waits, so the poll stops.
    rerender({ current: tabs });
    const settled = polls;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(polls).toBe(settled);
  });

  test("a rejection reaches the tab and a destructive toast; a failed poll is retried quietly", async () => {
    let polls = 0;
    mockGlobalFetch({
      "/api/approvals/req-1": () => {
        polls += 1;
        if (polls === 1) return { ok: false, status: 500, json: { error: "down" } };
        return { ok: true, json: { approval: { ...pending, status: "rejected", reviewer: "root" } } };
      },
      "/api/approvals": { ok: false, status: 500, json: { error: "down" } },
    });
    let tabs = [tab(pending)];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs = fn(tabs);
    });
    renderHook(() => useWriteApprovals({ tabs, setTabs, pollMs: 15 }));
    await waitFor(() => {
      if (tabs[0].approval?.status !== "rejected") throw new Error("not yet");
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Write rejected", variant: "destructive" }),
    );
  });

  test("a window that closed stays for the grace period, then goes", async () => {
    const until = new Date(Date.now() - CLOSED_WINDOW_GRACE_MS + 500).toISOString();
    mockGlobalFetch({
      "/api/approvals": {
        ok: true,
        json: { approvals: [{ ...pending, status: "approved", reviewer: "root", windowUntil: until }] },
      },
    });
    const { result } = renderHook(() => useWriteApprovals({ tabs: [tab()], setTabs: mock(() => {}) }));
    await waitFor(() => {
      if (!result.current.windowFor("orders")) throw new Error("not yet");
    });
    await waitFor(
      () => {
        if (result.current.windowFor("orders")) throw new Error("still there");
      },
      { timeout: 3000 },
    );
  });

  test("a network failure reading the windows is logged, not thrown", async () => {
    mockGlobalFetch({
      "/api/approvals": () => {
        throw new Error("offline");
      },
    });
    const { result } = renderHook(() => useWriteApprovals({ tabs: [tab()], setTabs: mock(() => {}) }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.windowFor("orders")).toBeNull();
  });

  test("a poll that throws is logged and retried; a decision landing after unmount is dropped", async () => {
    let polls = 0;
    mockGlobalFetch({
      "/api/approvals/req-1": () => {
        polls += 1;
        if (polls === 1) throw new Error("offline");
        return { ok: true, json: { approval: { ...pending, status: "rejected", reviewer: "root" } } };
      },
      "/api/approvals": { ok: true, json: { approvals: [] } },
    });
    let tabs = [tab(pending)];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs = fn(tabs);
    });
    const { unmount } = renderHook(() => useWriteApprovals({ tabs, setTabs, pollMs: 15 }));
    await waitFor(() => {
      if (tabs[0].approval?.status !== "rejected") throw new Error("not yet");
    });
    expect(polls).toBeGreaterThanOrEqual(2);

    // Unmounted while a poll is in flight: its answer must not touch the tabs any more.
    let release: (() => void) | null = null;
    mockGlobalFetch({
      "/api/approvals/req-2": () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              json: {
                approval: {
                  ...pending,
                  id: "req-2",
                  status: "approved",
                  reviewer: "root",
                  windowUntil: new Date(Date.now() + 60_000).toISOString(),
                },
              },
            });
        }),
      "/api/approvals": { ok: true, json: { approvals: [] } },
    });
    let late = [tab({ ...pending, id: "req-2" })];
    const setLate = mock((fn: unknown) => {
      if (typeof fn === "function") late = fn(late);
    });
    const second = renderHook(() => useWriteApprovals({ tabs: late, setTabs: setLate, pollMs: 15 }));
    await waitFor(() => {
      if (!release) throw new Error("no poll yet");
    });
    second.unmount();
    unmount();
    await act(async () => {
      release!();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(late[0].approval?.status).toBe("pending");
  });
});
