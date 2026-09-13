import "../setup-dom";

import { describe, test, expect, afterEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { useAllConnections } from "@/hooks/use-all-connections";

/** A managed connection as the API returns it (createdAt serialised as a string). */
const makeManagedConnection = (overrides: Record<string, unknown> = {}) => ({
  id: "seed:managed-1",
  seedId: "managed-1",
  name: "Managed DB",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "proddb",
  createdAt: "2026-02-01T00:00:00.000Z",
  managed: true,
  ...overrides,
});

/**
 * The list is the server's alone (docs/CONTEXT.md §4.1): there is no browser-held
 * connection to merge or to fall back to, so every failure mode below is an empty list.
 */
describe("useAllConnections", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("returns the managed list with createdAt revived, in server order", async () => {
    mockGlobalFetch({
      "/api/connections/managed": {
        json: { connections: [makeManagedConnection(), makeManagedConnection({ id: "seed:two", seedId: "two" })] },
      },
    });

    const { result } = renderHook(() => useAllConnections());
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.map((c) => c.id)).toEqual(["seed:managed-1", "seed:two"]);
    expect(result.current.connections[0].createdAt).toBeInstanceOf(Date);
  });

  test.each([
    ["an empty list", { json: { connections: [] } }],
    ["no connections field", { json: {} }],
    ["a non-ok response", { status: 500, json: { error: "Internal error" } }],
  ])("answers %s with an empty list", async (_label, response) => {
    mockGlobalFetch({ "/api/connections/managed": response });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections).toEqual([]);
  });

  test("a fetch that throws leaves an empty list rather than a pending one", async () => {
    mockGlobalFetch({
      "/api/connections/managed": () => {
        throw new Error("network down");
      },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections).toEqual([]);
  });

  test("does not update state when unmounted before fetch resolves", async () => {
    mockGlobalFetch({
      "/api/connections/managed": async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { json: { connections: [makeManagedConnection()] } };
      },
    });

    const { result, unmount } = renderHook(() => useAllConnections());

    expect(result.current.loading).toBe(true);
    unmount();

    // Let the pending fetch settle after unmount
    await new Promise((resolve) => setTimeout(resolve, 100));

    // State was never updated after cancellation
    expect(result.current.loading).toBe(true);
    expect(result.current.connections).toEqual([]);
  });
});
