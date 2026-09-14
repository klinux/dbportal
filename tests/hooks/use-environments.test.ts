import "../setup-dom";
import { describe, test, expect, afterEach } from "bun:test";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { useEnvironments } from "@/hooks/use-environments";
import { BUILTIN_ENVIRONMENTS } from "@/lib/types";

/** The environments hook (docs/CONTEXT.md §4.36): the built-ins at once, the server's list when it answers, the built-ins when it cannot. */
describe("useEnvironments", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("starts from the built-ins and takes the server's list", async () => {
    const qa = { id: "qa", label: "QA", color: "#abcdef", order: 2 };
    mockGlobalFetch({ "/api/environments": { ok: true, json: { environments: [qa] } } });
    const { result } = renderHook(() => useEnvironments());
    expect(result.current).toEqual([...BUILTIN_ENVIRONMENTS]);
    await waitFor(() => {
      if (result.current.length !== 1) throw new Error("not yet");
    });
    expect(result.current).toEqual([qa]);
  });

  test("keeps the built-ins when the server refuses or fails", async () => {
    mockGlobalFetch({ "/api/environments": { ok: false, status: 500, json: { error: "down" } } });
    const { result } = renderHook(() => useEnvironments());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual([...BUILTIN_ENVIRONMENTS]);
  });
});
