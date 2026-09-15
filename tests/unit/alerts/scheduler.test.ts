import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

/**
 * The alert scheduler (docs/CONTEXT.md §4.29): on unless told otherwise, off by default in
 * the agent role; one pass runs the due alerts in turn and is not doubled while it runs;
 * one interval per process, started once, stopped cleanly; a pass that throws is one
 * error line, not a dead scheduler.
 */
const errorLog = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn: () => {}, debug: () => {}, info: () => {}, error: errorLog } }));
let due: { id: string; state: Record<string, unknown> }[] = [];
let fail = false;
const marked: [string, Record<string, unknown>][] = [];
mock.module("@/lib/alerts/store", () => ({
  dueAlerts: async () => {
    if (fail) throw new Error("store down");
    return due;
  },
  updateAlertState: async (id: string, state: Record<string, unknown>) => {
    marked.push([id, state]);
    return null;
  },
}));
// The pass hands each due alert to the queue (§4.40); `release` holds the enqueue open to prove a pass is not doubled.
const ran: string[] = [];
let release: (() => void) | null = null;
mock.module("@/lib/jobs/queue", () => ({
  enqueueJob: async (input: {
    kind: string;
    payload: { alertId?: string };
    maxAttempts: number;
    requestedBy: string;
  }) => {
    if (input.kind !== "alert") {
      ran.push(`chore:${input.kind}`);
      return { id: `job-${input.kind}` };
    }
    ran.push(input.payload.alertId as string);
    expect(input).toMatchObject({ kind: "alert", maxAttempts: 1, requestedBy: "scheduler" });
    if (release) await new Promise<void>((r) => (release = r));
    return { id: `job-${input.payload.alertId}` };
  },
}));
// The scheduler's lease (§4.41): granted or not, as the store would; what was asked for is pinned.
let leader = true;
const leaseAsked: [string, number][] = [];
let choreDue = false;
mock.module("@/lib/leases", () => ({
  ALERT_SCHEDULER_LEASE: "alerts-scheduler",
  holdLease: async (name: string, ttlMs: number) => {
    leaseAsked.push([name, ttlMs]);
    return leader;
  },
  onceWithin: async () => choreDue,
  holdsLease: (name: string) => name === "alerts-scheduler" && leader,
}));
const {
  DEFAULT_TICK_MS,
  LEASE_TICKS,
  SCHEDULER_LEASE,
  alertsEnabled,
  isSchedulerLeader,
  startAlertScheduler,
  stopAlertScheduler,
  tickMs,
  tickOnce,
} = await import("@/lib/alerts/scheduler");

const saved: Record<string, string | undefined> = {};

describe("alerts scheduler", () => {
  beforeEach(() => {
    for (const k of ["ALERTS_ENABLED", "ALERTS_TICK_MS", "DBPORTAL_ROLE"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    due = [];
    fail = false;
    leader = true;
    choreDue = false;
    leaseAsked.length = 0;
    ran.length = 0;
    marked.length = 0;
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
    process.env.DBPORTAL_ROLE = "worker";
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
    due = [
      { id: "a", state: { status: "ok" } },
      { id: "b", state: { status: "firing", lastValue: "9" } },
    ];
    const t0 = new Date("2026-09-14T12:00:00.000Z");
    expect(await tickOnce(t0)).toBe(2);
    expect(ran).toEqual(["a", "b"]);
    // Each one is marked scheduled, its state otherwise kept, so the next pass does not hand it over again.
    expect(marked).toEqual([
      ["a", { status: "ok", lastScheduledAt: t0.toISOString() }],
      ["b", { status: "firing", lastValue: "9", lastScheduledAt: t0.toISOString() }],
    ]);
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

  // Several studios, one scheduler (§4.41): the lease is asked for every tick, for three ticks' worth, and a
  // tick without it hands nothing over - the due alerts wait for the instance that leads.
  test("a tick asks for the scheduler's lease and, without it, hands nothing over", async () => {
    due = [{ id: "a", state: { status: "ok" } }];
    leader = false;
    expect(await tickOnce()).toBe(0);
    expect(ran).toEqual([]);
    expect(marked).toEqual([]);
    expect(leaseAsked).toEqual([[SCHEDULER_LEASE, LEASE_TICKS * DEFAULT_TICK_MS]]);
    expect(isSchedulerLeader()).toBe(false);
    leader = true;
    expect(await tickOnce()).toBe(1);
    expect(isSchedulerLeader()).toBe(true);
  });

  // The daily chores (§4.43): the leader hands them to the queue once a day, before the alerts.
  test("the leader enqueues the daily chores once a day, ahead of the alerts", async () => {
    choreDue = true;
    due = [{ id: "a", state: { status: "ok" } }];
    expect(await tickOnce()).toBe(1);
    expect(ran).toEqual(["chore:audit-partitions", "a"]);
    leader = false;
    ran.length = 0;
    expect(await tickOnce()).toBe(0);
    expect(ran).toEqual([]);
  });
});
