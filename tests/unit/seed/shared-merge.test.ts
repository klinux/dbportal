import { describe, it, expect, beforeEach, mock } from "bun:test";
import path from "path";

/**
 * How the seed YAML and the shared datasource store become one list
 * (docs/CONTEXT.md §4.1 step B). Its own file because it mocks the store module, and
 * tests/unit/seed/index.test.ts exercises the real one.
 */
const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";
process.env.RUNTIME_PASS = "runtime-secret";

let shared: unknown[] = [];
let storeFails = false;
mock.module("@/lib/datasources/store", () => ({
  // The draft test's loan of a stored secret (§4.48) is not this file's subject: a draft passes through.
  withStoredSecret: async (draft: unknown) => draft,
  listSharedDatasources: async () => {
    if (storeFails) throw new Error("storage down");
    return shared;
  },
}));

const { getManagedConnections, getSeedConnectionById, getSeedConnectionByIdUnfiltered, getConfigSeedIds, resetCache } =
  await import("@/lib/seed");

const runtime = (overrides: Record<string, unknown> = {}) => ({
  id: "runtime-orders",
  name: "Orders (runtime)",
  type: "postgres",
  host: "orders.internal",
  password: "${RUNTIME_PASS}",
  environment: "production",
  roles: ["user"],
  managed: true,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  createdBy: "root",
  updatedBy: "root",
  ...overrides,
});

describe("seed index: shared store merge", () => {
  beforeEach(() => {
    resetCache();
    shared = [];
    storeFails = false;
  });

  it("a runtime datasource is listed after the YAML ones, role-filtered, with its reference resolved", async () => {
    shared = [runtime()];
    const forUser = await getManagedConnections(["user"]);
    const ids = forUser.map((c) => c.seedId);
    expect(ids.slice(-1)).toEqual(["runtime-orders"]);
    expect(ids).toContain("everyone");
    const record = forUser.find((c) => c.seedId === "runtime-orders")!;
    expect(record.id).toBe("seed:runtime-orders");
    expect(record.password).toBe("runtime-secret");
    expect(record.managed).toBe(true);
    expect(record.environment).toBe("production");
    // Roles hold for the runtime kind exactly as for the YAML kind.
    expect((await getManagedConnections(["admin"])).some((c) => c.seedId === "runtime-orders")).toBe(false);
    expect(await getSeedConnectionById("runtime-orders", ["user"])).not.toBeNull();
    expect(await getSeedConnectionByIdUnfiltered("runtime-orders")).not.toBeNull();
  });

  // What is declared in version control is the operator's explicit statement; a runtime
  // record with the same id cannot silently override it.
  it("the YAML wins an id collision", async () => {
    shared = [runtime({ id: "everyone", name: "Impostor", password: "x" })];
    const all = await getManagedConnections(["user"]);
    const everyone = all.filter((c) => c.seedId === "everyone");
    expect(everyone).toHaveLength(1);
    expect(everyone[0].name).toBe("Everyone DB");
    expect(everyone[0].password).toBe("shared-secret");
  });

  // A store that cannot be read costs the runtime records only; the YAML keeps working.
  it("a failing store leaves the YAML datasources in place", async () => {
    storeFails = true;
    const all = await getManagedConnections(["admin"]);
    expect(all.map((c) => c.seedId)).toContain("admin-only");
  });

  it("runtime records alone, with no YAML at all, are still served", async () => {
    process.env.SEED_CONFIG_PATH = "/nonexistent.yaml";
    resetCache();
    shared = [runtime({ roles: ["*"] })];
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toEqual(["runtime-orders"]);
    expect(await getSeedConnectionByIdUnfiltered("runtime-orders")).not.toBeNull();
    expect((await getConfigSeedIds()).size).toBe(0);
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
  });

  it("getConfigSeedIds names the YAML ids only", async () => {
    shared = [runtime()];
    const ids = await getConfigSeedIds();
    expect(ids.has("everyone")).toBe(true);
    expect(ids.has("runtime-orders")).toBe(false);
  });
});
