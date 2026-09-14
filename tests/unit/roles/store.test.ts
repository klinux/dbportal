import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Named roles (docs/CONTEXT.md §4.19): two sources merged, the seed file's first; which
 * roles a session is in, judged on its role, groups and username - never on a role;
 * validation of the id and the members; deletion; and a session that keeps its own
 * principals when the list cannot be read. The provider and the seed file are mocked.
 */
let serverStorage = true;
let rows: unknown[] | null = [];
const provider = {
  getCollection: mock(async () => {
    if (rows === null) throw new Error("disk");
    return rows;
  }),
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
  loadConfig: async () => ({ version: "1", connections: [], namedRoles: declared }),
}));
const logError = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { error: logError, warn: () => {}, info: () => {}, debug: () => {} } }));

const {
  NamedRoleError,
  createNamedRole,
  deleteNamedRole,
  listNamedRoles,
  namedRolesOf,
  resetNamedRolesCache,
  withNamedRoles,
} = await import("@/lib/roles/store");

const role = (over: Record<string, unknown> = {}) => ({
  id: "oncall",
  name: "On-call",
  members: ["group:sre-oncall", "user:ana@example.test"],
  ...over,
});
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof NamedRoleError ? e.statusCode : -1;
  }
};

describe("roles store", () => {
  beforeEach(() => {
    resetNamedRolesCache();
    serverStorage = true;
    rows = [];
    declared = [];
    provider.setCollection.mockClear();
    logError.mockClear();
  });

  test("creates a role under the reserved owner with the actor's stamp, and lists it after the seed file's", async () => {
    declared = [role({ id: "reviewer", name: "Reviewer", members: ["group:dba"] })];
    const record = await createNamedRole(role(), "root");
    expect(record).toMatchObject({ id: "oncall", createdBy: "root" });
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(["shared:roles", "named_roles"]);
    const list = await listNamedRoles();
    expect(list.map((e) => [e.role.id, e.source])).toEqual([
      ["reviewer", "config"],
      ["oncall", "store"],
    ]);
    // A stored role that shares an id with the seed file's is hidden by it.
    rows = [{ ...role({ id: "reviewer", name: "Shadow" }), createdAt: "x", createdBy: "x" }];
    resetNamedRolesCache();
    expect((await listNamedRoles()).map((e) => e.role.name)).toEqual(["Reviewer"]);
  });

  test("refuses a bad id, a blank name, no members, a member that is a role, and a duplicate", async () => {
    expect(await status(createNamedRole(role({ id: "On Call" }), "root"))).toBe(400);
    expect(await status(createNamedRole(role({ name: "" }), "root"))).toBe(400);
    expect(await status(createNamedRole(role({ members: [] }), "root"))).toBe(400);
    expect(await status(createNamedRole(role({ members: ["role:other"] }), "root"))).toBe(400);
    expect(await status(createNamedRole(role({ members: ["*"] }), "root"))).toBe(400);
    await createNamedRole(role(), "root");
    expect(await status(createNamedRole(role(), "root"))).toBe(409);
    declared = [role({ id: "reviewer" })];
    expect(await status(createNamedRole(role({ id: "reviewer" }), "root"))).toBe(409);
  });

  test("a session is in the roles whose members name its role, a group of its, or its username - never a role", async () => {
    declared = [
      role(),
      role({ id: "reviewer", name: "Reviewer", members: ["group:dba", "admin"] }),
      role({ id: "nested", name: "Nested", members: ["user:root"] }),
    ];
    expect(await namedRolesOf({ role: "user", username: "ana@example.test" })).toEqual(["oncall"]);
    expect(await namedRolesOf({ role: "user", username: "bob", groups: ["sre-oncall", "dba"] })).toEqual([
      "oncall",
      "reviewer",
    ]);
    expect(await namedRolesOf({ role: "admin", username: "root" })).toEqual(["reviewer", "nested"]);
    expect(await namedRolesOf({ role: "user", username: "nobody" })).toEqual([]);
    // Being in a role puts nobody in another role.
    expect(await namedRolesOf({ role: "user", username: "x", namedRoles: ["oncall"] })).toEqual([]);
  });

  test("withNamedRoles fills the session in, leaves it untouched when it is in none, and grants nothing when the list cannot be read", async () => {
    declared = [role()];
    const session = { role: "user" as const, username: "ana@example.test" };
    expect(await withNamedRoles<{ role: string; username: string; namedRoles?: string[] }>(session)).toEqual({
      ...session,
      namedRoles: ["oncall"],
    });
    const outsider = { role: "user" as const, username: "bob" };
    expect(await withNamedRoles(outsider)).toBe(outsider);
    rows = null;
    resetNamedRolesCache();
    expect(await withNamedRoles(session)).toBe(session);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test("deleting removes a stored role; an unknown id is 404; the cache serves reads for five seconds", async () => {
    const record = await createNamedRole(role(), "root");
    expect((await deleteNamedRole(record.id)).id).toBe(record.id);
    expect(rows).toEqual([]);
    expect(await status(deleteNamedRole("ghost"))).toBe(404);
    const reads = provider.getCollection.mock.calls.length;
    await listNamedRoles();
    await listNamedRoles();
    expect(provider.getCollection.mock.calls.length).toBe(reads);
  });

  test("without server storage the seed file's roles still apply, and a write is a 503 that names the setting", async () => {
    serverStorage = false;
    declared = [role()];
    expect(await namedRolesOf({ role: "user", groups: ["sre-oncall"] })).toEqual(["oncall"]);
    const err = await createNamedRole(role({ id: "other" }), "root").catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("STORAGE_PROVIDER");
  });
});
