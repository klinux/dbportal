import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

/**
 * The durable copy of the audit channel (docs/CONTEXT.md §4.2): how an event reaches the
 * server store, and what happens when the store is absent or down.
 */
let enabled = false;
let provider: { appendAuditEvent: ReturnType<typeof mock>; pruneAuditEvents?: ReturnType<typeof mock> } | null = null;
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => provider,
}));
let elasticOn = false;
const enqueued = mock((_line: Record<string, unknown>) => {});
mock.module("@/lib/audit-export/elastic", () => ({
  elasticConfig: () => (elasticOn ? { url: "https://es.example.test", index: "i", batch: 1, flushMs: 1 } : null),
  enqueueAuditExport: (line: Record<string, unknown>) => enqueued(line),
}));

const { emitAuditEvent, hasAuditPersistence, setAuditPersistence } = await import("@/lib/audit");
const { registerAuditPersistence, resetRetentionSweep, retentionDays, RETENTION_SWEEP_MS } = await import(
  "@/lib/audit-persistence"
);
const { logger } = await import("@/lib/logger");

const event = {
  type: "maintenance" as const,
  action: "vacuum",
  target: "users",
  user: "ana",
  result: "success" as const,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("audit persistence", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    enabled = false;
    provider = null;
    elasticOn = false;
    enqueued.mockClear();
    resetRetentionSweep();
    delete process.env.AUDIT_RETENTION_DAYS;
    setAuditPersistence(null);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    setAuditPersistence(null);
    logSpy.mockRestore();
  });

  test("without a sink an event is emitted and nothing else happens", async () => {
    expect(hasAuditPersistence()).toBe(false);
    const stored = emitAuditEvent(event);
    await flush();
    expect(stored.id).toBeTruthy();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  test("a registered sink receives the STORED event - sanitized, with its id and timestamp", async () => {
    const sink = mock(async (_e: unknown) => {});
    setAuditPersistence(sink);
    const stored = emitAuditEvent(event);
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toBe(stored);
  });

  // The line is already out and the request already answered: a store that is down costs
  // one error line, never the request.
  test("a failing sink is logged once per event and the emit still returns", async () => {
    setAuditPersistence(async () => {
      throw new Error("store down");
    });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const stored = emitAuditEvent(event);
      await flush();
      expect(stored.type).toBe("maintenance");
      expect(errorSpy).toHaveBeenCalledWith("Failed to persist audit event", expect.any(Error), {
        route: "audit",
        eventId: stored.id,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("registerAuditPersistence wires nothing on STORAGE_PROVIDER=local", () => {
    registerAuditPersistence();
    expect(hasAuditPersistence()).toBe(false);
  });

  test("registerAuditPersistence appends every event to the server store, resolved lazily", async () => {
    enabled = true;
    registerAuditPersistence();
    expect(hasAuditPersistence()).toBe(true);
    // Resolved on the first event, not at registration: no provider yet is a no-op.
    emitAuditEvent(event);
    await flush();
    provider = { appendAuditEvent: mock(async (_e: unknown) => {}) };
    const stored = emitAuditEvent(event);
    await flush();
    expect(provider.appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(provider.appendAuditEvent.mock.calls[0][0]).toBe(stored);
  });

  // docs/CONTEXT.md §4.12: the exporter is a second destination for the same line; it is
  // queued, never awaited, and works with or without a server store.
  test("with Elasticsearch configured the LINE is queued for export, with or without a store", async () => {
    elasticOn = true;
    registerAuditPersistence();
    expect(hasAuditPersistence()).toBe(true);
    const stored = emitAuditEvent(event);
    await flush();
    expect(enqueued).toHaveBeenCalledTimes(1);
    const line = enqueued.mock.calls[0][0] as Record<string, unknown>;
    expect(line.id).toBe(stored.id);
    expect(line.actor).toBe("ana");
    expect(line.event).toBe("maintenance");
    expect(line).not.toHaveProperty("user");

    enabled = true;
    provider = { appendAuditEvent: mock(async (_e: unknown) => {}) };
    setAuditPersistence(null);
    registerAuditPersistence();
    emitAuditEvent(event);
    await flush();
    expect(enqueued).toHaveBeenCalledTimes(2);
    expect(provider.appendAuditEvent).toHaveBeenCalledTimes(1);
  });

  test("retentionDays reads a positive whole number of days and nothing else", () => {
    expect(retentionDays()).toBeNull();
    process.env.AUDIT_RETENTION_DAYS = "0";
    expect(retentionDays()).toBeNull();
    process.env.AUDIT_RETENTION_DAYS = "1.5";
    expect(retentionDays()).toBeNull();
    process.env.AUDIT_RETENTION_DAYS = "90";
    expect(retentionDays()).toBe(90);
  });

  test("with a retention the store is swept after an append, at most once an hour, and a failed sweep is a warning", async () => {
    enabled = true;
    process.env.AUDIT_RETENTION_DAYS = "30";
    const prune = mock(async (_before: string) => 3);
    provider = { appendAuditEvent: mock(async (_e: unknown) => {}), pruneAuditEvents: prune };
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      registerAuditPersistence();
      emitAuditEvent(event);
      await flush();
      expect(prune).toHaveBeenCalledTimes(1);
      const before = Date.parse(prune.mock.calls[0][0] as string);
      expect(Math.abs(Date.now() - 30 * 24 * 3600_000 - before)).toBeLessThan(5_000);
      expect(info).toHaveBeenCalledTimes(1);
      // Within the hour, no second sweep.
      emitAuditEvent(event);
      await flush();
      expect(prune).toHaveBeenCalledTimes(1);
      // An hour later, one more; a sweep that removes nothing logs nothing; one that fails warns.
      const holder = globalThis as unknown as Record<symbol, number>;
      holder[Symbol.for("dbportal.audit-retention-sweep")] = Date.now() - RETENTION_SWEEP_MS - 1;
      prune.mockImplementationOnce(async () => 0);
      emitAuditEvent(event);
      await flush();
      expect(prune).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenCalledTimes(1);
      holder[Symbol.for("dbportal.audit-retention-sweep")] = Date.now() - RETENTION_SWEEP_MS - 1;
      prune.mockImplementationOnce(async () => {
        throw new Error("locked");
      });
      emitAuditEvent(event);
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(provider.appendAuditEvent).toHaveBeenCalledTimes(4);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
