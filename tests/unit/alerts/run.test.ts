import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AlertRecord, AlertState } from "@/lib/alerts/store";

/**
 * One run of an alert (docs/CONTEXT.md §4.29): the read under the owner's snapshot, the
 * state moved by the outcome - fired, held quiet inside the cooldown, fired again after it,
 * resolved - the channels told, a delivery that failed on the trail, and the three ways a
 * run fails without paging anyone: a statement that writes, an owner without access, an
 * engine error. Nothing here opens a database: the provider is a mock.
 */
const audit = mock((_e: Record<string, unknown>) => ({}));
// The real audit module with only the emitter swapped: audit-execution reads the rest of it.
const realAudit = await import("@/lib/audit");
mock.module("@/lib/audit", () => ({ ...realAudit, emitAuditEvent: audit }));
mock.module("@/lib/logger", () => ({ logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} } }));
mock.module("@/lib/roles/store", () => ({ withNamedRoles: async (s: unknown) => s }));
class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
let access: number | null = null;
/** The datasource's object rules (§4.56), when a test declares any. */
let rules: { match: string; roles: string[] }[] | undefined;
mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: async (body: { connectionId?: string }, session: { username: string }) => {
    if (access) throw new SeedConnectionError("no", access);
    return {
      id: body.connectionId,
      seedId: "orders",
      name: "Orders",
      type: "postgres",
      limits: { maxRows: 10 },
      opened: session.username,
      ...(rules === undefined ? {} : { objectRules: rules }),
    };
  },
}));
let rows: Record<string, unknown>[] = [{ count: 120 }];
const query = mock(async (_sql: string) => {
  if (rows.length === 0 && _sql.includes("boom")) throw new Error("relation missing");
  return { rows, fields: ["count"], rowCount: rows.length, executionTime: 1 };
});
const prepareQuery = mock((sql: string, options: unknown) => ({ query: sql, options }));
mock.module("@/lib/db", () => ({
  getOrCreateProvider: async () => ({ prepareQuery, query, getCapabilities: () => ({ containerLevels: [] }) }),
}));
const channels: Record<string, { id: string; name: string; kind: string; target: string }> = {
  ops: { id: "ops", name: "Ops", kind: "slack", target: "C1" },
};
mock.module("@/lib/channels/store", () => ({ findChannel: async (id: string) => channels[id] ?? null }));
const deliver = mock(async (_c: unknown, _m: unknown) => true);
mock.module("@/lib/notify/channels", () => ({ deliverToChannel: deliver }));
let written: AlertState | null = null;
mock.module("@/lib/alerts/store", () => ({
  updateAlertState: async (_id: string, state: AlertState) => {
    written = state;
    return null;
  },
}));

const { runAlert, transition } = await import("@/lib/alerts/run");

const record = (state: AlertState, over: Partial<AlertRecord> = {}): AlertRecord => ({
  id: "slow-orders",
  name: "Slow orders",
  datasource: "orders",
  sql: "SELECT count(*) AS count FROM orders",
  op: ">",
  value: 100,
  everyMinutes: 5,
  cooldownMinutes: 60,
  channels: ["ops"],
  enabled: true,
  owner: { username: "ana", role: "user" },
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  state,
  ...over,
});
const at = (iso: string) => new Date(iso);
const audited = (i: number) => (audit.mock.calls as unknown[][])[i]?.[0] as Record<string, unknown>;

describe("alerts run", () => {
  beforeEach(() => {
    audit.mockClear();
    deliver.mockClear();
    query.mockClear();
    prepareQuery.mockClear();
    access = null;
    rows = [{ count: 120 }];
    written = null;
    process.env.APP_URL = "https://portal.example.test";
  });

  test("transition: fires once, holds quiet inside the cooldown, fires again after it, resolves when it stops", () => {
    const t0 = at("2026-09-14T12:00:00.000Z");
    const fired = transition({ status: "ok" }, { holds: true, value: "120" }, 60, t0);
    expect(fired).toEqual({
      state: {
        status: "firing",
        lastRunAt: t0.toISOString(),
        lastValue: "120",
        lastError: undefined,
        lastFiredAt: t0.toISOString(),
        lastNotifiedAt: t0.toISOString(),
      },
      notify: "firing",
    });
    const quiet = transition(fired.state, { holds: true, value: "130" }, 60, at("2026-09-14T12:30:00.000Z"));
    expect(quiet.notify).toBeNull();
    expect(quiet.state).toMatchObject({
      status: "firing",
      lastFiredAt: t0.toISOString(),
      lastNotifiedAt: t0.toISOString(),
      lastValue: "130",
    });
    const again = transition(quiet.state, { holds: true, value: "140" }, 60, at("2026-09-14T13:00:00.000Z"));
    expect(again.notify).toBe("firing");
    expect(again.state.lastNotifiedAt).toBe("2026-09-14T13:00:00.000Z");
    // A cooldown of zero pages on every run while it holds.
    expect(transition(again.state, { holds: true, value: "1" }, 0, at("2026-09-14T13:00:30.000Z")).notify).toBe(
      "firing",
    );
    const resolved = transition(again.state, { holds: false, value: "5" }, 60, at("2026-09-14T14:00:00.000Z"));
    expect(resolved).toMatchObject({ state: { status: "ok", lastValue: "5" }, notify: "resolved" });
    expect(transition({ status: "unknown" }, { holds: false, value: "5" }, 60, t0).notify).toBeNull();
    expect(
      transition({ status: "error", lastError: "x" }, { holds: false, value: "5" }, 60, t0).state.lastError,
    ).toBeUndefined();
  });

  test("a run: the bounded read audited under the owner, the state written, the channels told when it fires and when it resolves", async () => {
    const t0 = at("2026-09-14T12:00:00.000Z");
    const state = await runAlert(record({ status: "ok" }), t0);
    expect(state).toMatchObject({ status: "firing", lastValue: "120", lastNotifiedAt: t0.toISOString() });
    expect(written).toEqual(state);
    // Bounded to the datasource's cap, below the alert's own.
    expect(prepareQuery.mock.calls[0][1]).toEqual({ limit: 10, unlimited: false });
    expect(audited(0)).toMatchObject({
      type: "query_execution",
      action: "alert",
      user: "ana",
      connectionName: "Orders",
      result: "success",
    });
    expect(audited(1)).toMatchObject({
      type: "alert",
      action: "fired",
      target: "slow-orders",
      user: "ana",
      details: "value > 100; value 120",
    });
    expect(deliver.mock.calls[0][0]).toEqual(channels.ops);
    expect(deliver.mock.calls[0][1]).toEqual({
      alertId: "slow-orders",
      alertName: "Slow orders",
      datasourceName: "Orders",
      state: "firing",
      value: "120",
      condition: "value > 100",
      at: t0.toISOString(),
      url: "https://portal.example.test/alerts",
    });
    rows = [{ count: 3 }];
    delete process.env.APP_URL;
    const back = await runAlert(record(state), at("2026-09-14T12:05:00.000Z"));
    expect(back.status).toBe("ok");
    expect(audited(3)).toMatchObject({ type: "alert", action: "resolved" });
    expect(deliver.mock.calls[1][1]).toMatchObject({ state: "resolved", value: "3", url: undefined });
  });

  test("a delivery that fails, and a channel nobody declared, each leave a line; the run still succeeds", async () => {
    deliver.mockImplementationOnce(async () => false);
    const state = await runAlert(
      record({ status: "ok" }, { channels: ["ops", "ghost"] }),
      at("2026-09-14T12:00:00.000Z"),
    );
    expect(state.status).toBe("firing");
    expect(audited(2)).toMatchObject({
      type: "alert",
      action: "delivery_failed",
      result: "failure",
      details: "channel ops",
    });
    expect(audited(3)).toMatchObject({ action: "delivery_failed", details: "channel ghost not declared" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  // docs/CONTEXT.md §4.56: an alert reads only what its owner may; a hidden object is "access", like a closed datasource.
  test("the owner's object rules: an alert on an object the owner may not use lands in error as access, and runs nothing", async () => {
    const t0 = at("2026-09-14T12:00:00.000Z");
    rules = [{ match: "orders", roles: ["admin"] }];
    const state = await runAlert(record({ status: "ok" }), t0);
    rules = undefined;
    expect(state).toMatchObject({ status: "error", lastError: "access" });
    expect(query).not.toHaveBeenCalled();
  });

  test("a statement that writes, an owner without access, and an engine error each land in error with a closed reason and page nobody", async () => {
    const t0 = at("2026-09-14T12:00:00.000Z");
    const write = await runAlert(record({ status: "firing", lastFiredAt: "x" }, { sql: "DELETE FROM orders" }), t0);
    expect(write).toEqual({ status: "error", lastFiredAt: "x", lastRunAt: t0.toISOString(), lastError: "not_a_read" });
    expect(query).not.toHaveBeenCalled();
    access = 404;
    expect((await runAlert(record({ status: "ok" }), t0)).lastError).toBe("access");
    access = 403;
    expect((await runAlert(record({ status: "ok" }), t0)).lastError).toBe("access");
    access = null;
    rows = [];
    const failed = await runAlert(record({ status: "ok" }, { sql: "SELECT boom" }), t0);
    expect(failed.status).toBe("error");
    expect(failed.lastError).toBe("execution_failed");
    expect(deliver).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => (c[0] as { action: string }).action === "fired")).toBe(false);
  });
});
