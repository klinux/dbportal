import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

/**
 * The durable copy of the audit channel (docs/CONTEXT.md §4.2): how an event reaches the
 * server store, and what happens when the store is absent or down.
 */
let enabled = false;
let provider: { appendAuditEvent: ReturnType<typeof mock> } | null = null;
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => provider,
}));

const { emitAuditEvent, hasAuditPersistence, setAuditPersistence } = await import("@/lib/audit");
const { registerAuditPersistence } = await import("@/lib/audit-persistence");
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
});
