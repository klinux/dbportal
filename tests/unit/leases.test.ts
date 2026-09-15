import { describe, test, expect, mock, beforeEach } from "bun:test";
import { FakeJobStore } from "./jobs/fake-store";

/**
 * Leases (docs/CONTEXT.md §4.41): a loop's leader elected on every tick - held, renewed,
 * lost when the store says so or does not answer, and the change of hands logged once each
 * way; a cooldown shared across instances that passes once per window; and, without a
 * server store, the one instance there is answers as such.
 */
let serverStorage = true;
let storeDown = false;
const store = new FakeJobStore();
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => serverStorage,
  getStorageProvider: async () => {
    if (storeDown) throw new Error("store down");
    return serverStorage ? store : null;
  },
}));
const info = mock((_m: string, _c: Record<string, unknown>) => {});
const warn = mock((_m: string, _c: Record<string, unknown>) => {});
mock.module("@/lib/logger", () => ({ logger: { info, warn, debug: () => {}, error: () => {} } }));
const { holdLease, holdsLease, instanceName, listLeases, onceWithin, resetLeases } = await import("@/lib/leases");

const t0 = new Date("2026-09-15T12:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("leases", () => {
  beforeEach(() => {
    resetLeases();
    store.leases.clear();
    serverStorage = true;
    storeDown = false;
    info.mockClear();
    warn.mockClear();
  });

  test("a lease is taken, renewed by its holder, refused to another while live, and taken over once expired", async () => {
    expect(instanceName()).toMatch(/^.+:\d+$/);
    expect(holdsLease("alerts-scheduler")).toBe(false);
    expect(await holdLease("alerts-scheduler", 90_000, t0)).toBe(true);
    expect(holdsLease("alerts-scheduler")).toBe(true);
    expect(await listLeases()).toEqual([
      { name: "alerts-scheduler", holder: instanceName(), until: later(90_000).toISOString() },
    ]);
    // Another instance asking while the lease is live is refused; the holder renews.
    expect(await store.acquireLease("alerts-scheduler", "other:1", later(10_000).toISOString(), "x")).toBe(false);
    expect(await holdLease("alerts-scheduler", 90_000, later(30_000))).toBe(true);
    expect((await listLeases())[0].until).toBe(later(120_000).toISOString());
    // The lease expired and another took it: this instance loses it, and says so once.
    expect(await store.acquireLease("alerts-scheduler", "other:1", later(200_000).toISOString(), "y")).toBe(true);
    expect(await holdLease("alerts-scheduler", 90_000, later(200_000))).toBe(false);
    expect(holdsLease("alerts-scheduler")).toBe(false);
    expect(info.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["Lease taken", "Lease lost"]);
  });

  test("a store that does not answer grants nothing, with one warning; no server store is the one instance", async () => {
    storeDown = true;
    expect(await holdLease("alerts-scheduler", 90_000, t0)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Lease could not be asked for",
      expect.objectContaining({ lease: "alerts-scheduler" }),
    );
    storeDown = false;
    serverStorage = false;
    expect(await holdLease("alerts-scheduler", 90_000, t0)).toBe(true);
    expect(await listLeases()).toEqual([]);
  });

  test("a cooldown passes once per window across instances, in memory without a server store", async () => {
    expect(await onceWithin("trail:x", 300_000, t0.getTime())).toBe(true);
    // The same instance again, and another instance, both inside the window: quiet.
    expect(await onceWithin("trail:x", 300_000, t0.getTime() + 1_000)).toBe(false);
    expect(await store.acquireLease("trail:x", "any", later(2_000).toISOString(), "z")).toBe(false);
    // The store's rule is strict: the window is over once the instant has passed.
    expect(await onceWithin("trail:x", 300_000, t0.getTime() + 300_001)).toBe(true);
    storeDown = true;
    expect(await onceWithin("trail:y", 300_000, t0.getTime())).toBe(false);
    expect(warn).toHaveBeenCalledWith("Cooldown could not be asked for", expect.objectContaining({ lease: "trail:y" }));
    storeDown = false;
    serverStorage = false;
    expect(await onceWithin("trail:z", 300_000, t0.getTime())).toBe(true);
    expect(await onceWithin("trail:z", 300_000, t0.getTime() + 1)).toBe(false);
    expect(await onceWithin("trail:z", 300_000, t0.getTime() + 300_000)).toBe(true);
  });
});
