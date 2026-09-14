import { describe, test, expect, mock, beforeEach } from "bun:test";

/** The trail alerts document (docs/CONTEXT.md §4.32): the defaults name no channel; a stored one is validated; a store that is not there answers the defaults on read and a 503 on write. */
let stored: unknown = null;
let available = true;
const provider = {
  getCollection: mock(async () => stored),
  setCollection: mock(async (_o: string, _c: string, value: unknown) => {
    stored = value;
  }),
};
mock.module("@/lib/storage/factory", () => ({ getStorageProvider: async () => (available ? provider : null) }));
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, info: () => {}, error: () => {}, debug: () => {} } }));
const { DEFAULT_TRAIL_ALERTS, TrailAlertsError, getTrailAlerts, resetTrailAlertsCache, saveTrailAlerts } = await import(
  "@/lib/trail-alerts/store"
);

describe("trail alerts store", () => {
  beforeEach(() => {
    resetTrailAlertsCache();
    stored = null;
    available = true;
    warn.mockClear();
  });

  test("reads the defaults when nothing is stored, the store is malformed, or the store is not there; caches what it read", async () => {
    expect(await getTrailAlerts()).toEqual(DEFAULT_TRAIL_ALERTS);
    resetTrailAlertsCache();
    stored = { rules: "no" };
    expect(await getTrailAlerts()).toEqual(DEFAULT_TRAIL_ALERTS);
    expect(warn).toHaveBeenCalledTimes(1);
    resetTrailAlertsCache();
    available = false;
    expect(await getTrailAlerts()).toEqual(DEFAULT_TRAIL_ALERTS);
    available = true;
    provider.getCollection.mockImplementationOnce(async () => {
      throw new Error("down");
    });
    resetTrailAlertsCache();
    expect(await getTrailAlerts()).toEqual(DEFAULT_TRAIL_ALERTS);
  });

  test("saves a valid document under the channels' owner and serves it back; refuses a bad one and a missing store", async () => {
    const config = {
      rules: { guardrail: ["ops"], production_export: [], backup_failed: ["ops"], seed_failed: [] },
      exportRowsThreshold: 500,
    };
    expect(await saveTrailAlerts(config, "root")).toEqual(config);
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      "shared:channels",
      "trail_alerts",
    ]);
    expect(await getTrailAlerts()).toEqual(config);
    await expect(saveTrailAlerts({ ...config, exportRowsThreshold: 0 }, "root")).rejects.toThrow(TrailAlertsError);
    await expect(saveTrailAlerts({ rules: { guardrail: ["Not Valid"] } }, "root")).rejects.toThrow(
      "Invalid trail alerts",
    );
    available = false;
    const err = await saveTrailAlerts(config, "root").catch((e) => e);
    expect(err.statusCode).toBe(503);
  });
});
