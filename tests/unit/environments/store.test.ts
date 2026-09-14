import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Environments (docs/CONTEXT.md §4.36): the built-ins, the seed file's and the store's
 * merged by id and ordered - a later source relabels, never removes - validation of a
 * declaration, and deletion only of a stored one that is not production and not in use.
 */
let serverStorage = true;
let rows: unknown[] | null = [];
const provider = {
  getCollection: mock(async () => rows),
  setCollection: mock(async (_o: string, _c: string, value: unknown[]) => {
    rows = value;
  }),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => serverStorage,
  getStorageProvider: async () => (serverStorage ? provider : null),
}));
let declared: unknown[] = [];
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({ version: "1", connections: [], environments: declared }),
}));

const {
  EnvironmentError,
  deleteEnvironment,
  environmentIds,
  listEnvironments,
  resetEnvironmentsCache,
  saveEnvironment,
} = await import("@/lib/environments/store");

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof EnvironmentError ? e.statusCode : -1;
  }
};
const never = async () => false;

describe("environments store", () => {
  beforeEach(() => {
    resetEnvironmentsCache();
    serverStorage = true;
    rows = [];
    declared = [];
    provider.setCollection.mockClear();
  });

  test("lists the five built-ins in order, with the seed file and the store relabelling or adding by id", async () => {
    expect((await listEnvironments()).map((e) => [e.environment.id, e.source])).toEqual([
      ["production", "builtin"],
      ["staging", "builtin"],
      ["development", "builtin"],
      ["local", "builtin"],
      ["other", "builtin"],
    ]);
    declared = [{ id: "staging", label: "HML", color: "#123456", order: 1 }];
    await saveEnvironment({ id: "qa", label: "QA", color: "#abcdef", order: 2 }, "root");
    await saveEnvironment({ id: "production", label: "PRD", color: "#ff0000", order: 0 }, "root");
    const list = await listEnvironments();
    expect(list.map((e) => `${e.environment.id}:${e.environment.label}:${e.source}`)).toEqual([
      "production:PRD:store",
      "staging:HML:config",
      "development:DEV:builtin",
      "qa:QA:store",
      "local:LOCAL:builtin",
      "other::builtin",
    ]);
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      "shared:environments",
      "environments",
    ]);
    expect(await environmentIds()).toEqual(new Set(["production", "staging", "development", "qa", "local", "other"]));
    // A saved definition replaces the earlier one under the same id.
    await saveEnvironment({ id: "qa", label: "Quality", color: "#abcdef", order: 2 }, "root");
    expect((await listEnvironments()).find((e) => e.environment.id === "qa")?.environment.label).toBe("Quality");
    expect(rows).toHaveLength(2);
  });

  test("refuses a bad id, a blank or long label, a colour that is not hex, and an order outside its bounds", async () => {
    expect(await status(saveEnvironment({ id: "Not Valid", label: "x", color: "#000000", order: 1 }, "root"))).toBe(
      400,
    );
    expect(await status(saveEnvironment({ id: "qa", label: "", color: "#000000", order: 1 }, "root"))).toBe(400);
    expect(await status(saveEnvironment({ id: "qa", label: "x".repeat(25), color: "#000000", order: 1 }, "root"))).toBe(
      400,
    );
    expect(await status(saveEnvironment({ id: "qa", label: "QA", color: "red", order: 1 }, "root"))).toBe(400);
    expect(await status(saveEnvironment({ id: "qa", label: "QA", color: "#000000", order: -1 }, "root"))).toBe(400);
  });

  test("deletes only a stored environment that is not production and not in use; 404 for a built-in or seed-file one", async () => {
    await saveEnvironment({ id: "qa", label: "QA", color: "#abcdef", order: 2 }, "root");
    expect(await status(deleteEnvironment("production", never))).toBe(409);
    expect(await status(deleteEnvironment("staging", never))).toBe(404);
    expect(await status(deleteEnvironment("qa", async () => true))).toBe(409);
    expect((await deleteEnvironment("qa", never)).id).toBe("qa");
    expect(rows).toEqual([]);
    expect(await status(deleteEnvironment("qa", never))).toBe(404);
  });

  test("without server storage the built-ins and the seed file's still apply, and a write is a 503 that names the setting", async () => {
    serverStorage = false;
    declared = [{ id: "qa", label: "QA", color: "#abcdef", order: 2 }];
    expect((await listEnvironments()).some((e) => e.environment.id === "qa")).toBe(true);
    const err = await saveEnvironment({ id: "x", label: "X", color: "#000000", order: 1 }, "root").catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("STORAGE_PROVIDER");
    resetEnvironmentsCache();
    rows = null;
    serverStorage = true;
    declared = [];
    expect((await listEnvironments()).length).toBe(5);
  });
});
