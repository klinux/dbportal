import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import type { AuditEvent } from "@/lib/audit";
import { clearRateLimitState } from "@/lib/api/rate-limit";

// ─── Mock audit buffer ──────────────────────────────────────────────────────
const mockEvents: AuditEvent[] = [
  {
    id: "evt-1",
    timestamp: "2026-02-14T10:00:00.000Z",
    type: "maintenance",
    action: "vacuum",
    target: "users",
    user: "admin",
    result: "success",
    duration: 150,
  },
  {
    id: "evt-2",
    timestamp: "2026-02-14T10:05:00.000Z",
    type: "query_execution",
    action: "SELECT",
    target: "orders",
    user: "admin",
    result: "success",
    duration: 25,
  },
];

const mockBuffer = {
  push: mock((event: Omit<AuditEvent, "id" | "timestamp">) => ({
    ...event,
    id: `evt-${Date.now()}`,
    timestamp: new Date().toISOString(),
  })),
  getRecent: mock((count: number) => mockEvents.slice(-count)),
  filter: mock((opts: { type?: string }) => {
    if (opts.type) return mockEvents.filter((e) => e.type === opts.type);
    return mockEvents;
  }),
  getAll: mock(() => mockEvents),
  size: mockEvents.length,
  clear: mock(() => {}),
};

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// The route's own role-denial audit line. Unlike the display-buffer push above, this one goes
// through emitAuditEvent — the authoritative channel — so it is mocked separately and asserted on
// directly rather than through the buffer.
const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => {});

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

// ─── Mock @/lib/audit BEFORE importing the route ────────────────────────────
mock.module("@/lib/audit", () => ({
  getServerAuditBuffer: mock(() => mockBuffer),
  // The POST handler calls sanitizeAuditInput directly and pushes the result to the buffer
  // itself — deliberately NOT emitAuditEvent, which would also grant this route stdout emission
  // (see the route's own comment for why). This mock is an identity passthrough: the real
  // sanitizer's behavior is covered end-to-end by tests/security/audit-redaction.test.ts, so this
  // file only needs to assert that the route wires the buffer correctly.
  sanitizeAuditInput: mock((event: Record<string, unknown>) => event),
  emitAuditEvent: mockEmitAuditEvent,
  AuditRingBuffer: class {},
  loadAuditFromStorage: mock(() => []),
  saveAuditToStorage: mock(() => {}),
}));

// The durable store (docs/CONTEXT.md §4.2): absent by default, so the buffer path below is what
// most tests exercise; a test that wants the store swaps it in.
let mockStore: {
  listAuditEvents: ReturnType<typeof mock>;
  countAuditEvents: ReturnType<typeof mock>;
} | null = null;
// The error mapper reaches the seed index and the datasource store, which bind the two
// names below too; a stub that carries only what the route calls fails at import.
mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => mockStore,
  isServerStorageEnabled: () => mockStore !== null,
  getStorageProviderType: () => (mockStore ? "postgres" : "local"),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { GET, POST } = await import("@/app/api/admin/audit/route");

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("/api/admin/audit", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockBuffer.push.mockClear();
    mockBuffer.getRecent.mockClear();
    mockBuffer.filter.mockClear();
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation(() => {});
    mockStore = null;
  });

  describe("GET /api/admin/audit", () => {
    // With a server store the answer is the durable record - every process, every restart -
    // and says so; the ring buffer is not consulted at all.
    test("reads the durable store when one is configured, type and limit included", async () => {
      mockStore = {
        listAuditEvents: mock(async () => [mockEvents[1]]),
        countAuditEvents: mock(async (_filter?: unknown) => 1234),
      };
      const res = await GET(createMockRequest("/api/admin/audit?type=query_execution&limit=7"));
      const data = await parseResponseJSON<{
        events: AuditEvent[];
        total: number;
        limit: number;
        offset: number;
        source: string;
      }>(res);
      expect(res.status).toBe(200);
      expect(mockStore.listAuditEvents).toHaveBeenCalledWith({ type: "query_execution", limit: 7, offset: 0 });
      expect(((mockStore.countAuditEvents as ReturnType<typeof mock>).mock.calls as unknown[][])[0]?.[0]).toEqual({
        type: "query_execution",
      });
      expect(data).toEqual({ events: [mockEvents[1]], total: 1234, limit: 7, offset: 0, source: "store" });
      expect(mockBuffer.getAll).not.toHaveBeenCalled();

      await GET(createMockRequest("/api/admin/audit"));
      expect(mockStore.listAuditEvents).toHaveBeenLastCalledWith({ limit: 100, offset: 0 });
      // docs/CONTEXT.md §4.27: the page's question, whole; a malformed one is a 400.
      await GET(createMockRequest("/api/admin/audit?actor=ana&connection=Orders&from=2026-09-01&offset=200&limit=50"));
      expect(((mockStore.listAuditEvents as ReturnType<typeof mock>).mock.calls as unknown[][]).at(-1)?.[0]).toEqual({
        actor: "ana",
        connectionName: "Orders",
        from: "2026-09-01T00:00:00.000Z",
        limit: 50,
        offset: 200,
      });
      expect((await GET(createMockRequest("/api/admin/audit?limit=0"))).status).toBe(400);
    });

    test("returns events as admin", async () => {
      const req = createMockRequest("/api/admin/audit");

      const res = await GET(req);
      const data = await parseResponseJSON<{ events: AuditEvent[]; total: number }>(res);

      expect(res.status).toBe(200);
      expect(data.events).toBeArray();
      expect(data.total).toBe(mockEvents.length);
    });

    test("returns 403 for non-admin", async () => {
      mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });

      const req = createMockRequest("/api/admin/audit");

      const res = await GET(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(403);
      expect(data.error).toContain("Unauthorized");
    });

    // Threat: a role denial that leaves no trace. An authenticated caller probing for a role it
    // does not hold was invisible in the one channel this project treats as authoritative.
    test("non-admin denial emits permission_denied with reason insufficient_role", async () => {
      mockGetSession.mockResolvedValueOnce({ role: "user", username: "bob" });

      const res = await GET(createMockRequest("/api/admin/audit"));

      expect(res.status).toBe(403);
      expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitAuditEvent.mock.calls[0][0];
      expect(event.type).toBe("permission_denied");
      expect(event.reason).toBe("insufficient_role");
      expect(event.user).toBe("bob");
      expect(event.target).toBe("GET /api/admin/audit");
    });

    // Threat the metering answers: this endpoint needs no admin role to REACH, so any ordinary
    // authenticated user can poll it. Unmetered, that writes one line per request into a fixed
    // 1000-entry ring and onto stdout, evicting the events an operator actually needs.
    test("the audit line is bounded per identity while the 403 stays unconditional", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        mockGetSession.mockResolvedValueOnce({ role: "user", username: "flooder" });
        statuses.push((await GET(createMockRequest("/api/admin/audit"))).status);
      }

      // The denial is never what gets rationed.
      expect(statuses).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
      // anon defaults to 5 per 300s and the trip is itself recorded, so eight probes leave six
      // lines. Pinned rather than bounded: an unmetered emit writes eight.
      expect(mockEmitAuditEvent).toHaveBeenCalledTimes(6);
      clearRateLimitState();
    });

    // This route has no guardRoute in front of it, so its 403 covers both "no session" and "wrong
    // role". Only the latter is a ROLE denial; recording insufficient_role for an anonymous caller
    // would both misname the reason and let an unauthenticated caller flood the trail for free.
    test("an absent session emits nothing", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const res = await GET(createMockRequest("/api/admin/audit"));

      expect(res.status).toBe(403);
      expect(mockEmitAuditEvent).not.toHaveBeenCalled();
    });

    test("a broken audit sink does not turn the role denial into a 500", async () => {
      mockGetSession.mockResolvedValueOnce({ role: "user", username: "bob" });
      mockEmitAuditEvent.mockImplementationOnce(() => {
        throw new Error("audit sink unavailable");
      });

      const res = await GET(createMockRequest("/api/admin/audit"));

      expect(res.status).toBe(403);
    });

    test("filters the ring by the same question, newest first, and pages it", async () => {
      const res = await GET(createMockRequest("/api/admin/audit?type=maintenance"));
      const data = await parseResponseJSON<{ events: AuditEvent[]; total: number; source: string }>(res);
      expect(res.status).toBe(200);
      expect(mockBuffer.getAll).toHaveBeenCalled();
      expect(data.events.every((e) => e.type === "maintenance")).toBe(true);
      expect(data.total).toBe(mockEvents.filter((e) => e.type === "maintenance").length);
      expect(data.source).toBe("buffer");
      const paged = await parseResponseJSON<{ events: AuditEvent[]; total: number; offset: number }>(
        await GET(createMockRequest("/api/admin/audit?limit=1&offset=1")),
      );
      expect(paged.total).toBe(mockEvents.length);
      expect(paged.events).toEqual([[...mockEvents].reverse()[1]]);
      expect(paged.offset).toBe(1);
    });

    test("returns 500 when buffer read fails", async () => {
      mockBuffer.getAll.mockImplementationOnce(() => {
        throw new Error("Buffer read failed");
      });

      const req = createMockRequest("/api/admin/audit");

      const res = await GET(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(500);
      expect(data.error).toBe("Buffer read failed");
    });
  });

  describe("POST /api/admin/audit", () => {
    test("creates event as admin", async () => {
      const req = createMockRequest("/api/admin/audit", {
        method: "POST",
        body: {
          type: "maintenance",
          action: "analyze",
          target: "products",
          result: "success",
        },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{ event: AuditEvent }>(res);

      expect(res.status).toBe(200);
      expect(data.event).toBeDefined();
      expect(mockBuffer.push).toHaveBeenCalledTimes(1);
      // Verify user was injected from session
      const pushCall = mockBuffer.push.mock.calls[0][0] as Record<string, unknown>;
      expect(pushCall.user).toBe("admin");
    });

    test("returns 403 for non-admin on POST", async () => {
      mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });

      const req = createMockRequest("/api/admin/audit", {
        method: "POST",
        body: {
          type: "maintenance",
          action: "vacuum",
          target: "users",
          result: "success",
        },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(403);
      expect(data.error).toContain("Unauthorized");
    });

    test("non-admin denial emits permission_denied with reason insufficient_role", async () => {
      mockGetSession.mockResolvedValueOnce({ role: "user", username: "bob" });

      const res = await POST(
        createMockRequest("/api/admin/audit", {
          method: "POST",
          body: { type: "maintenance", action: "vacuum", target: "users", result: "success" },
        }),
      );

      expect(res.status).toBe(403);
      expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
      const event = mockEmitAuditEvent.mock.calls[0][0];
      expect(event.reason).toBe("insufficient_role");
      expect(event.target).toBe("POST /api/admin/audit");
    });

    test("a broken audit sink does not turn the role denial into a 500", async () => {
      mockGetSession.mockResolvedValueOnce({ role: "user", username: "bob" });
      mockEmitAuditEvent.mockImplementationOnce(() => {
        throw new Error("audit sink unavailable");
      });

      const res = await POST(
        createMockRequest("/api/admin/audit", {
          method: "POST",
          body: { type: "maintenance", action: "vacuum", target: "users", result: "success" },
        }),
      );

      expect(res.status).toBe(403);
    });

    test("returns 500 on error", async () => {
      mockBuffer.push.mockImplementationOnce(() => {
        throw new Error("Buffer full");
      });

      const req = createMockRequest("/api/admin/audit", {
        method: "POST",
        body: {
          type: "maintenance",
          action: "vacuum",
          target: "users",
          result: "success",
        },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(500);
      expect(data.error).toBe("Buffer full");
    });
  });
});
