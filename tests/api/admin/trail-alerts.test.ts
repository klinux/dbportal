import { describe, test, expect, mock } from "bun:test";

/** The trail alerts route (docs/CONTEXT.md §4.32): admin only; the document read and saved with an audit line; the store's refusals answered. */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const real = await import("@/lib/trail-alerts/store");
const config = {
  rules: { guardrail: ["ops"], production_export: [], backup_failed: [], seed_failed: [] },
  exportRowsThreshold: 10,
};
const save = mock(async (_i: unknown, _by: string) => config);
mock.module("@/lib/trail-alerts/store", () => ({ ...real, getTrailAlerts: async () => config, saveTrailAlerts: save }));
const { GET, PUT } = await import("@/app/api/admin/trail-alerts/route");
const url = "http://localhost/api/admin/trail-alerts";
const put = (body: string) =>
  PUT(new Request(url, { method: "PUT", body, headers: { "Content-Type": "application/json" } }));

describe("/api/admin/trail-alerts", () => {
  test("admin only; reads and saves the document with an audit line; refusals come back", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({ trailAlerts: config });
    expect(await (await put(JSON.stringify(config))).json()).toEqual({ trailAlerts: config });
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "alert",
      action: "trail_rules_saved",
      user: "root",
      details: "guardrail=1 production_export=0 backup_failed=0 seed_failed=0",
    });
    expect((await put("[]")).status).toBe(400);
    save.mockImplementationOnce(async () => {
      throw new real.TrailAlertsError("Invalid trail alerts", 400);
    });
    expect((await put("{}")).status).toBe(400);
    save.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect((await put("{}")).status).toBe(500);
    session = { role: "user", username: "ana" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await put("{}")).status).toBe(403);
  });
});
