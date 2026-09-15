import { describe, it, expect, beforeEach } from "bun:test";
import path from "node:path";

/**
 * A virtual datasource resolved for a person (docs/CONTEXT.md §4.44): each member resolved
 * as that person would resolve it, a member the person may not open closing the whole
 * thing with the same 403, and the rules that travel with it - no writes for anyone,
 * exports only where every member allows.
 */
const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "virtual-config.yaml");
process.env.ORDERS_PASS = "o-secret";
process.env.CRM_PASS = "c-secret";

import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { getManagedConnections } from "@/lib/seed";
import { canExport, canWrite } from "@/lib/access";
import { resetCache } from "@/lib/seed/config-loader";
import { clearRateLimitState } from "@/lib/api/rate-limit";

describe("a virtual datasource, resolved", () => {
  beforeEach(() => {
    resetCache();
    clearRateLimitState();
  });

  it("resolves every member as the person, credentials included, and writes for nobody", async () => {
    const virtual = await resolveConnection({ connectionId: "seed:orders-crm" }, { role: "user", username: "ana" });
    expect(virtual.type).toBe("virtual");
    expect(virtual.members).toEqual(["orders", "crm"]);
    expect(virtual.memberConnections?.map((m) => [m.seedId, m.type, m.password])).toEqual([
      ["orders", "postgres", "o-secret"],
      ["crm", "mysql", "c-secret"],
    ]);
    expect(canWrite(virtual, { role: "admin", username: "root" })).toBe(false);
    // The environment is the members' (the default here), and no address of its own.
    expect(virtual.environment).toBe("staging");
    expect(virtual.host).toBeUndefined();
  });

  it("is closed to whoever cannot open every member, and absent from their list", async () => {
    // An administrator may open orders but not crm, whose roles name users and a group.
    await expect(
      resolveConnection({ connectionId: "seed:orders-crm" }, { role: "admin", username: "root" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const listed = (await getManagedConnections(["*", "admin"])).map((c) => c.seedId);
    expect(listed).toContain("orders");
    expect(listed).not.toContain("orders-crm");
    expect((await getManagedConnections(["*", "user"])).map((c) => c.seedId)).toContain("orders-crm");
    try {
      await resolveConnection({ connectionId: "seed:orders-crm" }, { role: "admin", username: "root" });
    } catch (error) {
      expect(error).toBeInstanceOf(SeedConnectionError);
    }
  });

  it("exports only where every member would: crm names a group, so a plain user may not", async () => {
    const asUser = await resolveConnection({ connectionId: "seed:orders-crm" }, { role: "user", username: "ana" });
    expect(canExport(asUser, { role: "user", username: "ana" })).toBe(false);
    expect(canExport(asUser, { role: "user", username: "ana", groups: ["backend"] })).toBe(true);
  });
});
