import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readEnv, resetLegacyEnvWarnings } from "@/lib/config/env-alias";

/**
 * The rename with a fallback (docs/CONTEXT.md §5, layer 3): DBPORTAL_* wins, LIBREDB_* is
 * read when only it is set, and the first such read says so once.
 */
describe("readEnv", () => {
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    delete process.env.DBPORTAL_PROBE_X;
    delete process.env.LIBREDB_PROBE_X;
    resetLegacyEnvWarnings();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.DBPORTAL_PROBE_X;
    delete process.env.LIBREDB_PROBE_X;
  });

  test("the new name wins, the old name is a fallback that warns once, nothing set is undefined", () => {
    expect(readEnv("PROBE_X")).toBeUndefined();
    process.env.LIBREDB_PROBE_X = "old";
    expect(readEnv("PROBE_X")).toBe("old");
    expect(readEnv("PROBE_X")).toBe("old");
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("LIBREDB_PROBE_X is deprecated"))).toHaveLength(1);
    process.env.DBPORTAL_PROBE_X = "new";
    expect(readEnv("PROBE_X")).toBe("new");
    process.env.DBPORTAL_PROBE_X = "";
    expect(readEnv("PROBE_X")).toBe("");
  });
});
