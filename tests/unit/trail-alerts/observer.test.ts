import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AuditEvent } from "@/lib/audit";

/**
 * The observer (docs/CONTEXT.md §4.32): an event that trips a rule with channels named is
 * delivered once per rule and datasource per cooldown; the datasource's environment comes
 * from the seed file and the store; a refused delivery is on the trail; the observer's own
 * lines and a rule with no channel fire nothing; and, registered, a throwing pass is one
 * error line.
 */
const emitted = mock((_e: Record<string, unknown>) => ({}));
const realAudit = await import("@/lib/audit");
mock.module("@/lib/audit", () => ({ ...realAudit, emitAuditEvent: emitted }));
const errorLog = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: errorLog, debug: () => {} } }));
let config = {
  rules: { guardrail: ["ops"], production_export: ["ops", "ghost"], backup_failed: [], seed_failed: ["ops"] },
  exportRowsThreshold: 100,
};
let failConfig = false;
const realStore = await import("@/lib/trail-alerts/store");
mock.module("@/lib/trail-alerts/store", () => ({
  ...realStore,
  getTrailAlerts: async () => {
    if (failConfig) throw new Error("store down");
    return config;
  },
}));
mock.module("@/lib/channels/store", () => ({
  findChannel: async (id: string) => (id === "ops" ? { id: "ops", name: "Ops", kind: "slack", target: "C1" } : null),
}));
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({ version: "1", connections: [{ id: "prod", name: "Prod", environment: "production" }] }),
}));
mock.module("@/lib/datasources/store", () => ({
  listSharedDatasources: async () => [{ id: "stage", name: "Stage", environment: "staging" }],
}));
const deliver = mock(async (_c: unknown, _m: unknown) => true);
mock.module("@/lib/notify/channels", () => ({ deliverToChannel: deliver }));

const { resetLeases } = await import("@/lib/leases");
const { TRAIL_COOLDOWN_MS, observeForTrailAlerts, registerTrailAlerts, resetTrailAlertsState } = await import(
  "@/lib/trail-alerts/observer"
);
const { setAuditObserver } = realAudit;

const event = (over: Partial<AuditEvent>): AuditEvent => ({
  id: "e1",
  timestamp: "2026-09-14T12:00:00.000Z",
  type: "data_export",
  action: "csv",
  target: "POST /api/db/export",
  user: "ana",
  result: "success",
  rows: 500,
  connectionName: "Prod",
  ...over,
});
const t0 = Date.parse("2026-09-14T12:00:00.000Z");

describe("trail alerts observer", () => {
  beforeEach(() => {
    resetTrailAlertsState();
    // The cooldown lives with the leases (§4.41): in memory here, with no server store.
    resetLeases();
    deliver.mockClear();
    emitted.mockClear();
    errorLog.mockClear();
    failConfig = false;
  });

  test("delivers a tripped rule to its channels once per cooldown, with the environment read off the seed file and the store", async () => {
    expect(await observeForTrailAlerts(event({}), t0)).toBe("production_export");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toEqual({
      alertId: "trail-production_export",
      alertName: "A large export left production",
      datasourceName: "Prod",
      state: "firing",
      value: "ana exported 500 rows as csv",
      condition: "A large export left production",
      at: "2026-09-14T12:00:00.000Z",
    });
    // "ghost" is named but not declared: on the trail, not a crash.
    expect(emitted.mock.calls[0][0]).toMatchObject({
      type: "alert",
      action: "delivery_failed",
      target: "trail-production_export",
      details: "channel ghost not declared",
    });
    // The same rule on the same datasource inside the cooldown is quiet; after it, told again.
    expect(await observeForTrailAlerts(event({ id: "e2" }), t0 + 1000)).toBeNull();
    expect(await observeForTrailAlerts(event({ id: "e3" }), t0 + TRAIL_COOLDOWN_MS)).toBe("production_export");
    // A staging export, and one without a datasource, fire nothing; a guardrail does, on its own key.
    expect(await observeForTrailAlerts(event({ connectionName: "Stage" }), t0)).toBeNull();
    expect(
      await observeForTrailAlerts(
        event({
          type: "permission_denied",
          action: "denied",
          result: "failure",
          reason: "guardrail",
          connectionName: undefined,
        }),
        t0,
      ),
    ).toBe("guardrail");
    // A rule with no channel is nothing; the observer's own lines are nothing.
    expect(await observeForTrailAlerts(event({ type: "backup", action: "created", result: "failure" }), t0)).toBeNull();
    expect(await observeForTrailAlerts(event({ type: "alert", action: "fired" }), t0)).toBeNull();
    // A refused delivery is on the trail.
    deliver.mockImplementationOnce(async () => false);
    await observeForTrailAlerts(
      event({ type: "data_seed", action: "failed", result: "failure", connectionName: "Stage" }),
      t0,
    );
    expect(emitted.mock.calls.at(-1)?.[0]).toMatchObject({ action: "delivery_failed", details: "channel ops" });
  });

  test("registered on the channel, a pass that throws is one error line", async () => {
    let observer: ((e: AuditEvent) => Promise<void>) | null = null;
    const spy = mock((o: ((e: AuditEvent) => Promise<void>) | null) => {
      observer = o;
    });
    mock.module("@/lib/audit", () => ({ ...realAudit, emitAuditEvent: emitted, setAuditObserver: spy }));
    registerTrailAlerts();
    expect(observer).not.toBeNull();
    failConfig = true;
    await observer!(event({}));
    expect(errorLog).toHaveBeenCalledTimes(1);
    setAuditObserver(null);
  });
});
