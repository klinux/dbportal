import { describe, test, expect, beforeEach, mock } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * The export record (docs/CONTEXT.md §4.22, first half): a session tells the server it
 * exported a result, the datasource is resolved the way every route resolves it, and one
 * `data_export` event names who, which datasource, which form and how many rows - never a row.
 */
let session: { role: string; username: string } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const emitAuditEvent = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent }));
class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}
mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: async (body: { connectionId?: string }) => {
    if (body.connectionId === "seed:orders") return { id: "seed:orders", name: "Orders", type: "postgres" };
    throw new SeedConnectionError(`Seed connection "${body.connectionId}" not found`, 404);
  },
}));

const { POST } = await import("@/app/api/audit/export/route");

const post = (body?: unknown) =>
  POST(
    new Request("http://localhost/api/audit/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "10.0.0.7" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );

describe("POST /api/audit/export", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
    emitAuditEvent.mockClear();
  });

  test("needs a session", async () => {
    session = null;
    expect((await post({ connectionId: "seed:orders", format: "csv", rows: 3 })).status).toBe(401);
  });

  test("records the export with the datasource's own name, the form and the row count", async () => {
    const res = await post({ connectionId: "seed:orders", format: "sql-insert", rows: 42 });
    expect(res.status).toBe(200);
    expect((emitAuditEvent.mock.calls[0] as unknown[])[0]).toMatchObject({
      type: "data_export",
      action: "sql-insert",
      user: "ana",
      connectionName: "Orders",
      details: "42 rows",
      result: "success",
    });
  });

  test("refuses a bad form, a bad row count, no body, and a datasource the session may not open, recording nothing", async () => {
    expect((await post({ connectionId: "seed:orders", format: "xlsx", rows: 1 })).status).toBe(400);
    expect((await post({ connectionId: "seed:orders", format: "csv", rows: -1 })).status).toBe(400);
    expect((await post({ connectionId: "seed:orders", format: "csv", rows: 1.5 })).status).toBe(400);
    expect((await post()).status).toBe(400);
    expect((await post({ connectionId: "seed:payroll", format: "csv", rows: 1 })).status).toBe(404);
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });
});
