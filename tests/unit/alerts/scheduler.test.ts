import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

/**
 * The alert scheduler (docs/CONTEXT.md §4.29): on unless told otherwise, off by default in
 * the agent role; one pass runs the due alerts in turn and is not doubled while it runs;
 * one interval per process, started once, stopped cleanly; a pass that throws is one
 * error line, not a dead scheduler.
 */
const errorLog = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn: () => {}, debug: () => {}, info: () => {}, error: errorLog } }));
let due: { id: string }[] = [];
let fail = false;
mock.module("@/lib/alerts/store", () => ({
  dueAlerts: async () => {
    if (fail) throw new Error("store down");
    return due;
  },
}));
const ran: string[] = [];
let release: (() => void) | null = null;
mock.module("@/lib/alerts/run", () => ({
  runAlert: async (a: { id: string }) => {
    ran.push(a.id);
    if (release) await new Promise<void>((r) => (release = r));
    return { status: "ok" };
  },
}));
const { DEFAULT_TICK_MS, alertsEnabled, startAlertScheduler, stopAlertScheduler, tickMs, tickOnce } = await import(
  "@/lib/alerts/scheduler"
);

const saved: Record<string, string | undefined> = {};

describe("alerts scheduler", () => {
  beforeEach(() => {
    for (const k of ["ALERTS_ENABLED", "ALERTS_TICK_MS", "DBPORTAL_ROLE"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    due = [];
    fail = false;
    ran.length = 0;
    errorLog.mockClear();
  });
  afterEach(() => {
    stopAlertScheduler();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("on by default, off in the agent role, and the flag wins either way; the tick has a floor", () => {
    expect(alertsEnabled()).toBe(true);
    process.env.DBPORTAL_ROLE = "agent";
    expect(alertsEnabled()).toBe(false);
    process.env.ALERTS_ENABLED = "true";
    expect(alertsEnabled()).toBe(true);
    delete process.env.DBPORTAL_ROLE;
    process.env.ALERTS_ENABLED = "false";
    expect(alertsEnabled()).toBe(false);
    process.env.ALERTS_ENABLED = "1";
    expect(alertsEnabled()).toBe(true);
    expect(tickMs()).toBe(DEFAULT_TICK_MS);
    process.env.ALERTS_TICK_MS = "500";
    expect(tickMs()).toBe(DEFAULT_TICK_MS);
    process.env.ALERTS_TICK_MS = "5000";
    expect(tickMs()).toBe(5000);
  });

  test("a pass runs every due alert in turn, is not doubled while running, and survives a failing store", async () => {
    due = [{ id: "a" }, { id: "b" }];
    expect(await tickOnce()).toBe(2);
    expect(ran).toEqual(["a", "b"]);
    // A second pass while the first is inside a run is skipped.
    release = () => {};
    const first = tickOnce();
    await new Promise((r) => setTimeout(r, 5));
    expect(await tickOnce()).toBe(0);
    const pending = release as unknown as () => void;
    release = null;
    pending();
    await first;
    fail = true;
    expect(await tickOnce()).toBe(0);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  test("starts one interval per process and stops it; nothing starts where alerts are off", () => {
    process.env.ALERTS_ENABLED = "false";
    expect(startAlertScheduler()).toBe(false);
    delete process.env.ALERTS_ENABLED;
    process.env.ALERTS_TICK_MS = "1000";
    expect(startAlertScheduler()).toBe(true);
    expect(startAlertScheduler()).toBe(true);
    stopAlertScheduler();
    stopAlertScheduler();
  });
});
