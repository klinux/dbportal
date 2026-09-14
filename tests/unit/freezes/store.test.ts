import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Freeze windows (docs/CONTEXT.md §4.17): two sources merged, the seed file's first; which
 * window covers a datasource at an instant; validation of the two instants and the ids;
 * and deletion as the way a window ends early. The provider and the seed file are mocked.
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
  loadConfig: async () => ({ version: "1", connections: [], freezeWindows: declared }),
}));

const {
  FreezeError,
  activeFreeze,
  covers,
  createFreezeWindow,
  deleteFreezeWindow,
  listFreezeWindows,
  resetFreezeCache,
} = await import("@/lib/freezes/store");

const T0 = Date.parse("2026-09-14T10:00:00.000Z");
const window = (over: Record<string, unknown> = {}) => ({
  id: "release-42",
  reason: "Release 42 deploy",
  from: "2026-09-14T09:00:00.000Z",
  until: "2026-09-14T12:00:00.000Z",
  ...over,
});
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof FreezeError ? e.statusCode : -1;
  }
};

describe("freezes store", () => {
  beforeEach(() => {
    resetFreezeCache();
    serverStorage = true;
    rows = [];
    declared = [];
    provider.setCollection.mockClear();
  });

  test("covers: inside the instants, and either every datasource or the ones named", () => {
    expect(covers(window(), "orders", T0)).toBe(true);
    expect(covers(window(), "orders", Date.parse("2026-09-14T08:59:59.000Z"))).toBe(false);
    expect(covers(window(), "orders", Date.parse("2026-09-14T12:00:00.000Z"))).toBe(false);
    expect(covers(window({ datasources: ["orders"] }), "orders", T0)).toBe(true);
    expect(covers(window({ datasources: ["orders"] }), "billing", T0)).toBe(false);
    expect(covers(window({ datasources: [] }), "billing", T0)).toBe(true);
  });

  test("creates a window under the reserved owner with the actor's stamp, and lists it after the seed file's", async () => {
    declared = [window({ id: "peak-day", reason: "Peak day", datasources: ["orders"] })];
    const record = await createFreezeWindow(window(), "root");
    expect(record).toMatchObject({ id: "release-42", createdBy: "root" });
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      "shared:freezes",
      "freeze_windows",
    ]);
    const list = await listFreezeWindows();
    expect(list.map((e) => [e.window.id, e.source])).toEqual([
      ["peak-day", "config"],
      ["release-42", "store"],
    ]);
    // A stored window that shares an id with the seed file's is hidden by it.
    rows = [{ ...window({ id: "peak-day", reason: "Shadow" }), createdAt: "x", createdBy: "x" }];
    resetFreezeCache();
    expect((await listFreezeWindows()).map((e) => e.window.reason)).toEqual(["Peak day"]);
  });

  test("refuses a bad id, an end before the start, a malformed datasource id, a non-datetime, and a duplicate", async () => {
    expect(await status(createFreezeWindow(window({ id: "Not Valid" }), "root"))).toBe(400);
    expect(await status(createFreezeWindow(window({ until: "2026-09-14T08:00:00.000Z" }), "root"))).toBe(400);
    expect(await status(createFreezeWindow(window({ datasources: ["Not Valid"] }), "root"))).toBe(400);
    expect(await status(createFreezeWindow(window({ from: "yesterday" }), "root"))).toBe(400);
    expect(await status(createFreezeWindow(window({ reason: "" }), "root"))).toBe(400);
    await createFreezeWindow(window(), "root");
    expect(await status(createFreezeWindow(window(), "root"))).toBe(409);
    declared = [window({ id: "peak-day" })];
    expect(await status(createFreezeWindow(window({ id: "peak-day" }), "root"))).toBe(409);
  });

  test("activeFreeze answers the window covering the datasource now, the one ending last of several, or null", async () => {
    declared = [window({ id: "short", until: "2026-09-14T11:00:00.000Z" })];
    await createFreezeWindow(
      window({ id: "long", until: "2026-09-14T13:00:00.000Z", datasources: ["orders"] }),
      "root",
    );
    expect((await activeFreeze("orders", T0))?.id).toBe("long");
    expect((await activeFreeze("billing", T0))?.id).toBe("short");
    expect(await activeFreeze("billing", Date.parse("2026-09-14T11:30:00.000Z"))).toBeNull();
  });

  test("deleting ends a stored window; an unknown id is 404; the cache serves reads for five seconds", async () => {
    const record = await createFreezeWindow(window(), "root");
    expect((await deleteFreezeWindow(record.id)).id).toBe(record.id);
    expect(rows).toEqual([]);
    expect(await status(deleteFreezeWindow("ghost"))).toBe(404);
    const reads = provider.getCollection.mock.calls.length;
    await listFreezeWindows();
    await listFreezeWindows();
    expect(provider.getCollection.mock.calls.length).toBe(reads);
  });

  test("without server storage the seed file's windows still apply, and a write is a 503 that names the setting", async () => {
    serverStorage = false;
    declared = [window()];
    expect((await activeFreeze("orders", T0))?.id).toBe("release-42");
    const err = await createFreezeWindow(window({ id: "other" }), "root").catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("STORAGE_PROVIDER");
    resetFreezeCache();
    rows = null;
    serverStorage = true;
    declared = [];
    expect(await listFreezeWindows()).toEqual([]);
  });
});
