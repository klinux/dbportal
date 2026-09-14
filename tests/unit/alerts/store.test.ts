import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * The alert store (docs/CONTEXT.md §4.29): a definition validated, saved with its owner's
 * principal snapshot and kept state, listed to its owner or to an administrator, deleted
 * by the same, its state written by the runner alone, and the due list the scheduler reads.
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

const {
  AlertError,
  channelInUse,
  deleteAlert,
  dueAlerts,
  findAlert,
  listAlerts,
  mayManage,
  ownerOf,
  saveAlert,
  updateAlertState,
  validateAlert,
} = await import("@/lib/alerts/store");

const ana = { role: "user", username: "ana", groups: ["sre"], namedRoles: ["oncall"] };
const bob = { role: "user", username: "bob" };
const root = { role: "admin", username: "root" };
const base = {
  id: "slow-orders",
  name: "Slow orders",
  datasource: "orders",
  sql: "SELECT count(*) AS count FROM orders WHERE age > 1",
  op: ">",
  value: 100,
  everyMinutes: 5,
  cooldownMinutes: 60,
  channels: ["ops"],
  enabled: true,
};
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof AlertError ? e.statusCode : -1;
  }
};

describe("alerts store", () => {
  beforeEach(() => {
    serverStorage = true;
    rows = [];
    provider.setCollection.mockClear();
  });

  test("validates the shape: a comparison needs a value, the row and change operators do not", () => {
    expect(validateAlert(base)).toMatchObject({ id: "slow-orders", op: ">", value: 100 });
    expect(validateAlert({ ...base, op: "no_rows", value: undefined }).op).toBe("no_rows");
    expect(validateAlert({ ...base, op: "changed", value: undefined, column: "version" }).column).toBe("version");
    for (const bad of [
      { ...base, value: undefined },
      { ...base, op: "~" },
      { ...base, everyMinutes: 0 },
      { ...base, sql: "" },
      { ...base, channels: ["Not Valid"] },
      { ...base, datasource: "seed:orders" },
    ]) {
      expect(() => validateAlert(bad)).toThrow(AlertError);
    }
  });

  test("saves with the owner's snapshot and a fresh state, keeps the state on replace, and refuses someone else's", async () => {
    const saved = await saveAlert(validateAlert(base), ana);
    expect(saved.owner).toEqual({ username: "ana", role: "user", groups: ["sre"], namedRoles: ["oncall"] });
    expect(saved.state).toEqual({ status: "unknown" });
    expect(ownerOf(bob)).toEqual({ username: "bob", role: "user" });
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(["shared:alerts", "alerts"]);
    await updateAlertState("slow-orders", {
      status: "firing",
      lastValue: "120",
      lastRunAt: "2026-09-14T00:00:00.000Z",
    });
    expect(await updateAlertState("ghost", { status: "ok" })).toBeNull();
    const replaced = await saveAlert(validateAlert({ ...base, name: "Slower" }), root);
    expect(replaced.state.status).toBe("firing");
    expect(replaced.owner.username).toBe("root");
    expect(replaced.createdAt).toBe(saved.createdAt);
    await updateAlertState("slow-orders", { status: "ok" });
    expect(await status(saveAlert(validateAlert(base), bob))).toBe(403);
    expect(mayManage((await findAlert("slow-orders"))!, ana)).toBe(false);
    expect(mayManage((await findAlert("slow-orders"))!, root)).toBe(true);
    serverStorage = false;
    expect(await status(saveAlert(validateAlert(base), ana))).toBe(503);
    expect(await findAlert("slow-orders")).toBeNull();
  });

  test("lists the session's own, every one to an administrator; deletes by the same rule; a channel in use is known", async () => {
    await saveAlert(validateAlert(base), ana);
    await saveAlert(validateAlert({ ...base, id: "bobs", channels: ["pager"] }), bob);
    expect((await listAlerts(ana)).map((a) => a.id)).toEqual(["slow-orders"]);
    expect((await listAlerts(root)).map((a) => a.id).sort()).toEqual(["bobs", "slow-orders"]);
    expect(await channelInUse("pager")).toBe(true);
    expect(await channelInUse("ghost")).toBe(false);
    expect(await status(deleteAlert("bobs", ana))).toBe(403);
    expect(await status(deleteAlert("ghost", ana))).toBe(404);
    expect((await deleteAlert("bobs", root)).id).toBe("bobs");
    expect((await listAlerts(root)).map((a) => a.id)).toEqual(["slow-orders"]);
  });

  test("the due list: enabled alerts never run or run longer ago than their interval, oldest first", async () => {
    const t0 = Date.parse("2026-09-14T12:00:00.000Z");
    await saveAlert(validateAlert({ ...base, id: "never" }), ana);
    await saveAlert(validateAlert({ ...base, id: "fresh" }), ana);
    await saveAlert(validateAlert({ ...base, id: "stale" }), ana);
    await saveAlert(validateAlert({ ...base, id: "off", enabled: false }), ana);
    await updateAlertState("fresh", { status: "ok", lastRunAt: new Date(t0 - 4 * 60_000).toISOString() });
    await updateAlertState("stale", { status: "ok", lastRunAt: new Date(t0 - 6 * 60_000).toISOString() });
    await updateAlertState("off", { status: "ok" });
    expect((await dueAlerts(t0)).map((a) => a.id)).toEqual(["never", "stale"]);
    serverStorage = false;
    expect(await dueAlerts(t0)).toEqual([]);
  });
});
