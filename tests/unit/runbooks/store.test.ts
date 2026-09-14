import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Runbooks (docs/CONTEXT.md §4.20): two sources merged, the seed file's first; validation
 * of the statement's placeholders against the declared parameters; deletion; and the
 * binding that turns `{{name}}` into the engine's own placeholder with the values beside
 * it, typed as declared and never written into the statement.
 */
let serverStorage = true;
let rows: unknown[] | null = [];
const provider = {
  getCollection: mock(async () => rows),
  setCollection: mock(async (_o: string, _c: string, value: unknown[]) => {
    rows = value;
  }),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => serverStorage,
  getStorageProvider: async () => (serverStorage ? provider : null),
}));
let declared: unknown[] = [];
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({ version: "1", connections: [], runbooks: declared }),
}));

const { RunbookError, bindRunbook, createRunbook, deleteRunbook, findRunbook, listRunbooks, resetRunbooksCache } =
  await import("@/lib/runbooks/store");
type Runbook = import("@/lib/runbooks/store").Runbook;

const runbook = (over: Record<string, unknown> = {}): Runbook => ({
  id: "customer-orders",
  name: "Orders of a customer",
  datasource: "orders",
  sql: "SELECT * FROM orders WHERE customer_id = {{ customer_id }} AND status = {{status}} LIMIT {{limit}}",
  params: [
    { name: "customer_id", type: "number", label: "Customer" },
    { name: "status", type: "string", default: "open" },
    { name: "limit", type: "number", required: false },
  ],
  ...(over as Partial<Runbook>),
});
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof RunbookError ? e.statusCode : -1;
  }
};
const bindError = (...args: Parameters<typeof bindRunbook>) => {
  try {
    bindRunbook(...args);
    return null;
  } catch (e) {
    return e instanceof RunbookError ? `${e.statusCode} ${e.message}` : "other";
  }
};

describe("runbooks store", () => {
  beforeEach(() => {
    resetRunbooksCache();
    serverStorage = true;
    rows = [];
    declared = [];
    provider.setCollection.mockClear();
  });

  test("creates a runbook under the reserved owner with the actor's stamp, lists it after the seed file's, finds it by id", async () => {
    declared = [runbook({ id: "seeded", name: "Seeded" })];
    const record = await createRunbook(runbook(), "root");
    expect(record).toMatchObject({ id: "customer-orders", createdBy: "root" });
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(["shared:runbooks", "runbooks"]);
    expect((await listRunbooks()).map((e) => [e.runbook.id, e.source])).toEqual([
      ["seeded", "config"],
      ["customer-orders", "store"],
    ]);
    expect((await findRunbook("seeded"))?.name).toBe("Seeded");
    expect(await findRunbook("ghost")).toBeNull();
    // A stored runbook that shares an id with the seed file's is hidden by it.
    rows = [{ ...runbook({ id: "seeded", name: "Shadow" }), createdAt: "x", createdBy: "x" }];
    resetRunbooksCache();
    expect((await listRunbooks()).map((e) => e.runbook.name)).toEqual(["Seeded"]);
  });

  test("refuses a bad id, an undeclared placeholder, a duplicate parameter name, a bad parameter name, and a duplicate id", async () => {
    expect(await status(createRunbook(runbook({ id: "Not Valid" }), "root"))).toBe(400);
    expect(await status(createRunbook(runbook({ sql: "SELECT {{nope}}" }), "root"))).toBe(400);
    expect(
      await status(
        createRunbook(
          runbook({
            sql: "SELECT {{a}}",
            params: [
              { name: "a", type: "string" },
              { name: "a", type: "number" },
            ],
          }),
          "root",
        ),
      ),
    ).toBe(400);
    expect(await status(createRunbook(runbook({ params: [{ name: "Bad Name", type: "string" }] }), "root"))).toBe(400);
    await createRunbook(runbook(), "root");
    expect(await status(createRunbook(runbook(), "root"))).toBe(409);
    declared = [runbook({ id: "seeded" })];
    expect(await status(createRunbook(runbook({ id: "seeded" }), "root"))).toBe(409);
  });

  test("binds each placeholder to the engine's positional form, typed as declared, defaults and optionals included", () => {
    const pg = bindRunbook(runbook(), { customer_id: "42", limit: "" }, "postgres");
    expect(pg).toEqual({
      sql: "SELECT * FROM orders WHERE customer_id = $1 AND status = $2 LIMIT $3",
      params: [42, "open", null],
    });
    const my = bindRunbook(runbook(), { customer_id: 7, status: "closed", limit: 10 }, "mysql");
    expect(my.sql).toBe("SELECT * FROM orders WHERE customer_id = ? AND status = ? LIMIT ?");
    expect(my.params).toEqual([7, "closed", 10]);
    expect(bindRunbook(runbook(), { customer_id: 1 }, "oracle").sql).toContain(":1 AND status = :2 LIMIT :3");
    expect(bindRunbook(runbook(), { customer_id: 1 }, "mssql").sql).toContain("@p1 AND status = @p2 LIMIT @p3");
    // A value named twice is bound twice; a boolean is read from the form's text; a number becomes text where text is asked.
    const twice = runbook({
      sql: "SELECT {{flag}}, {{flag}}, {{note}}",
      params: [
        { name: "flag", type: "boolean" },
        { name: "note", type: "string" },
      ],
    });
    expect(bindRunbook(twice, { flag: "true", note: 5 }, "postgres")).toEqual({
      sql: "SELECT $1, $2, $3",
      params: [true, true, "5"],
    });
    expect(bindRunbook(twice, { flag: false, note: "x" }, "sqlite").params).toEqual([false, false, "x"]);
    // No placeholder, no parameter: the statement is itself, on any engine.
    expect(bindRunbook(runbook({ sql: "SELECT 1", params: undefined }), {}, "redis")).toEqual({
      sql: "SELECT 1",
      params: [],
    });
  });

  test("refuses a missing required value, a value of the wrong type, an engine without bound parameters, and an undeclared name", () => {
    expect(bindError(runbook(), {}, "postgres")).toBe('400 "Customer" is required');
    expect(bindError(runbook(), { customer_id: "abc" }, "postgres")).toBe('400 "Customer" must be a number');
    expect(bindError(runbook(), { customer_id: " " }, "postgres")).toBe('400 "Customer" is required');
    const flag = runbook({ sql: "SELECT {{flag}}", params: [{ name: "flag", type: "boolean" }] });
    expect(bindError(flag, { flag: "yes" }, "postgres")).toBe('400 "flag" must be true or false');
    const note = runbook({ sql: "SELECT {{note}}", params: [{ name: "note", type: "string" }] });
    expect(bindError(note, { note: { a: 1 } }, "postgres")).toBe('400 "note" must be text');
    expect(bindError(runbook(), { customer_id: 1 }, "redis")).toContain("400 Runbooks with parameters need an engine");
    const undeclared = { ...runbook({ sql: "SELECT {{ghost}}" }) } as never;
    expect(bindError(undeclared, { customer_id: 1 }, "postgres")).toContain('undeclared parameter "ghost"');
  });

  test("deleting removes a stored runbook; an unknown id is 404; without server storage the seed file's still apply and a write is 503", async () => {
    const record = await createRunbook(runbook(), "root");
    expect((await deleteRunbook(record.id)).id).toBe(record.id);
    expect(rows).toEqual([]);
    expect(await status(deleteRunbook("ghost"))).toBe(404);
    serverStorage = false;
    declared = [runbook()];
    expect((await listRunbooks()).map((e) => e.source)).toEqual(["config"]);
    const err = await createRunbook(runbook({ id: "other" }), "root").catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("STORAGE_PROVIDER");
    resetRunbooksCache();
    rows = null;
    serverStorage = true;
    declared = [];
    expect(await listRunbooks()).toEqual([]);
  });
});
