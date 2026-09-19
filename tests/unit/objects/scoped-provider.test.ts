import { describe, test, expect } from "bun:test";
import { createMockProvider } from "../../helpers/mock-provider";
import { ObjectHiddenError, scopeProvider } from "@/lib/objects/scoped-provider";
import { UNRESTRICTED, type ObjectScope } from "@/lib/objects/rules";
import type { DatabaseObject } from "@/lib/db/types";

/**
 * The provider every object route reads through (docs/CONTEXT.md §4.56): what the scope
 * hides is not listed, not counted, not described - and a hidden object's detail is "not
 * found", the same answer as one that does not exist.
 */
const objects: DatabaseObject[] = [
  { path: ["public", "orders"], name: "orders", kind: "table" },
  { path: ["public", "secrets"], name: "secrets", kind: "table" },
  { path: ["audit", "orders"], name: "orders", kind: "table" },
] as DatabaseObject[];

const scope: ObjectScope = { restricted: true, patterns: ["public.orders"] };

function provider(overrides: Parameters<typeof createMockProvider>[0] = {}) {
  return createMockProvider({
    objects,
    counts: { table: { count: 3 }, view: { unavailable: "no views here" }, index: { count: 2, sampledFrom: "x" } },
    objectDetails: { details: objects.map((object) => ({ path: object.path, columns: [], indexes: [], foreignKeys: [] })) },
    capabilities: {
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        { id: "index", role: "config", label: "Index", labelPlural: "Indexes" },
        { id: "routine", role: "config", label: "Routine", labelPlural: "Routines" },
      ],
    },
    ...overrides,
  });
}

describe("scopeProvider", () => {
  test("an unrestricted scope is the provider itself, untouched", () => {
    const raw = provider();
    expect(scopeProvider(raw, UNRESTRICTED)).toBe(raw);
  });

  test("lists only what the scope shows", async () => {
    const scoped = scopeProvider(provider(), scope);
    expect((await scoped.listObjects(["public"], "table")).map((object) => object.path)).toEqual([["public", "orders"]]);
  });

  test("recounts every counted kind from the listing, keeps the engine's unavailable ones, drops a kind it never counted", async () => {
    const scoped = scopeProvider(provider(), scope);
    expect(await scoped.countObjects(["public"])).toEqual({
      table: { count: 1 },
      view: { unavailable: "no views here" },
      // A sampled count becomes the exact count of what the listing showed.
      index: { count: 1 },
    });
  });

  test("a hidden object's detail is not found, the way a missing object is", async () => {
    const scoped = scopeProvider(provider(), scope);
    expect((await scoped.describeObject(["public", "orders"], "table")).path).toEqual(["public", "orders"]);
    const failure = scoped.describeObject(["public", "secrets"], "table");
    await expect(failure).rejects.toBeInstanceOf(ObjectHiddenError);
    await expect(failure).rejects.toThrow("No table named secrets");
    await expect(scoped.describeObject([], "table")).rejects.toThrow("No table named ");
    expect(new ObjectHiddenError(["x"], "table").status).toBe(404);
  });

  test("a batch detail keeps only the visible objects' details and the batch's own bound", async () => {
    const raw = provider({
      objectDetails: {
        details: objects.map((object) => ({ path: object.path, columns: [], indexes: [], foreignKeys: [] })),
        truncated: { limit: 3, reason: "bounded" },
      },
    });
    const scoped = scopeProvider(raw, scope);
    const batch = await scoped.describeObjects(["public"], "table", 3);
    expect(batch.details.map((detail) => detail.path)).toEqual([["public", "orders"]]);
    expect(batch.truncated).toEqual({ limit: 3, reason: "bounded" });
  });

  test("monitoring rows are filtered: statistics by the table's address, statements by what they name", async () => {
    const tables = [
      { schemaName: "public", tableName: "orders", rowCount: 1, totalSize: "1 B", totalSizeBytes: 1 },
      { schemaName: "public", tableName: "secrets", rowCount: 1, totalSize: "1 B", totalSizeBytes: 1 },
      // An engine with no containers reports an empty schema: the address is the name alone.
      { schemaName: "", tableName: "orders", rowCount: 1, totalSize: "1 B", totalSizeBytes: 1 },
    ];
    const indexes = tables.map((t) => ({ ...t, indexName: `${t.tableName}_pk`, columns: ["id"], isUnique: true, isPrimary: true, indexSize: "1 B", indexSizeBytes: 1, scans: 0 }));
    const statements = [
      "SELECT * FROM public.orders WHERE id = 1",
      "SELECT * FROM public.secrets",
      // Unqualified, and the scope is a qualified pattern with no default schema to place it in: hidden.
      "SELECT * FROM orders",
      "<IDLE>",
      "",
    ];
    const slowQueries = statements.map((query) => ({ query, calls: 1, totalTime: 1, avgTime: 1, rows: 1 }));
    const activeSessions = statements.map((query, pid) => ({ pid, user: "u", database: "d", state: "active", query, duration: "1s", durationMs: 1 }));
    const raw = provider({ tableStats: tables, indexStats: indexes, slowQueries, activeSessions, monitoring: { timestamp: new Date(0), tables, slowQueries } });
    const scoped = scopeProvider(raw, { restricted: true, patterns: ["public.orders"] });

    expect((await scoped.getTableStats()).map((t) => `${t.schemaName}.${t.tableName}`)).toEqual(["public.orders"]);
    expect((await scoped.getIndexStats()).map((i) => i.indexName)).toEqual(["orders_pk"]);
    expect((await scoped.getSlowQueries()).map((q) => q.query)).toEqual(["SELECT * FROM public.orders WHERE id = 1", ""]);
    expect((await scoped.getActiveSessions()).map((s) => s.pid)).toEqual([0, 4]);
    const data = await scoped.getMonitoringData();
    expect(data.tables?.map((t) => t.tableName)).toEqual(["orders"]);
    expect(data.slowQueries?.map((q) => q.query)).toEqual(["SELECT * FROM public.orders WHERE id = 1", ""]);
    // Members the engine did not answer stay absent rather than becoming empty lists.
    expect(data.indexes).toBeUndefined();
    expect(data.activeSessions).toBeUndefined();
  });

  test("a scope on a relation name shows a search cluster's statistics, and a non-SQL engine's statements are all dropped", async () => {
    const tables = [{ schemaName: "", tableName: "apim-1", rowCount: 1, totalSize: "1 B", totalSizeBytes: 1 }];
    const scoped = scopeProvider(
      provider({ type: "mongodb", tableStats: tables, slowQueries: [{ query: "db.apim.find()", calls: 1, totalTime: 1, avgTime: 1, rows: 1 }], capabilities: { containerLevels: [] } }),
      { restricted: true, patterns: ["apim-*"] },
    );
    expect((await scoped.getTableStats()).map((t) => t.tableName)).toEqual(["apim-1"]);
    expect(await scoped.getSlowQueries()).toEqual([]);
  });

  test("everything else reaches the provider unchanged, methods bound to it", async () => {
    const raw = provider();
    const scoped = scopeProvider(raw, scope);
    expect(scoped.type).toBe(raw.type);
    expect(scoped.getCapabilities()).toEqual(raw.getCapabilities());
    expect(await scoped.listContainers()).toEqual([]);
  });
});
