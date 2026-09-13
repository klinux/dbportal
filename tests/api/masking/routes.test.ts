import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";

/**
 * The masking configuration routes (docs/CONTEXT.md §4.7) over a mocked store: any session
 * may read what is in force, administrators replace it, and the replacement is audited.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({
  getSession: async () => session,
  signJWT: mock(async () => "t"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));
const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));

class MaskingError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}
const mockSave = mock(async (input: unknown) => input as typeof DEFAULT_MASKING_CONFIG);
mock.module("@/lib/masking/store", () => ({
  MaskingError,
  getServerMaskingConfig: async () => DEFAULT_MASKING_CONFIG,
  saveServerMaskingConfig: mockSave,
}));
mock.module("@/lib/masking/errors", () => ({ MaskingError }));

const { GET: read } = await import("@/app/api/masking/route");
const { GET: adminRead, PUT: replace } = await import("@/app/api/admin/masking/route");

describe("masking routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "admin", username: "root" };
    mockEmitAuditEvent.mockClear();
    mockSave.mockClear();
  });

  test("GET /api/masking answers the configuration to any session and 401 to none", async () => {
    session = { role: "user", username: "bob" };
    const res = await read();
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ config: unknown }>(res)).config).toEqual(DEFAULT_MASKING_CONFIG);
    session = null;
    expect((await read()).status).toBe(401);
  });

  test("the admin routes refuse a non-admin with 403", async () => {
    session = { role: "user", username: "bob" };
    expect((await adminRead(createMockRequest("/api/admin/masking"))).status).toBe(403);
    expect(
      (await replace(createMockRequest("/api/admin/masking", { method: "PUT", body: DEFAULT_MASKING_CONFIG }))).status,
    ).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("PUT replaces the configuration, audits it, and answers the store's refusals with their status", async () => {
    expect((await adminRead(createMockRequest("/api/admin/masking"))).status).toBe(200);
    const next = { ...DEFAULT_MASKING_CONFIG, enabled: false };
    const res = await replace(createMockRequest("/api/admin/masking", { method: "PUT", body: next }));
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ config: { enabled: boolean } }>(res)).config.enabled).toBe(false);
    expect(mockSave).toHaveBeenCalledWith(next, "root");
    expect(mockEmitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "masking_config", action: "updated", user: "root", result: "success" }),
    );

    expect((await replace(createMockRequest("/api/admin/masking", { method: "PUT", body: "nope" }))).status).toBe(400);
    mockSave.mockImplementationOnce(async () => {
      throw new MaskingError(
        "Invalid masking configuration: patterns.0.columnPatterns.0 must be a valid regular expression",
        400,
      );
    });
    const invalid = await replace(createMockRequest("/api/admin/masking", { method: "PUT", body: next }));
    expect(invalid.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(invalid)).error).toContain("regular expression");
    mockSave.mockImplementationOnce(async () => {
      throw new Error("store down");
    });
    expect((await replace(createMockRequest("/api/admin/masking", { method: "PUT", body: next }))).status).toBe(500);
  });
});
