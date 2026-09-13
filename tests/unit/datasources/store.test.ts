import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * The shared datasource store (docs/CONTEXT.md §4.1 step B) against an in-memory stand-in
 * for the server storage provider. Encryption is not exercised here on purpose: it is
 * installed by src/lib/storage/factory.ts around whatever provider it builds, and
 * tests/unit/lib/storage/encrypting-provider.test.ts proves that layer; what THIS file
 * proves is what the store writes into that layer and what it hands back.
 */
let rows: Record<string, unknown[]> = {};
let enabled = true;
let reads = 0;
const provider = {
  getCollection: mock(async (owner: string, collection: string) => {
    reads += 1;
    return rows[`${owner}/${collection}`] ?? null;
  }),
  setCollection: mock(async (owner: string, collection: string, data: unknown[]) => {
    rows[`${owner}/${collection}`] = data;
  }),
};

mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled ? provider : null),
}));

const {
  SharedDatasourceError,
  createSharedDatasource,
  deleteSharedDatasource,
  isSharedStoreAvailable,
  listSharedDatasources,
  resetSharedDatasourceCache,
  toSharedDatasourceView,
  updateSharedDatasource,
} = await import("@/lib/datasources/store");
const { SHARED_DATASOURCES_OWNER } = await import("@/lib/datasources/owner");

const valid = {
  id: "prod-orders",
  name: "Orders (production)",
  type: "postgres",
  host: "orders.internal",
  port: 5432,
  database: "orders",
  user: "portal",
  password: "hunter2",
  environment: "production",
  roles: ["admin", "user"],
};

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    expect(err).toBeInstanceOf(SharedDatasourceError);
    return (err as InstanceType<typeof SharedDatasourceError>).statusCode;
  }
}

describe("shared datasource store", () => {
  beforeEach(() => {
    rows = {};
    enabled = true;
    reads = 0;
    resetSharedDatasourceCache();
  });

  // A deployment on STORAGE_PROVIDER=local has the seed YAML and nothing else. That is a
  // valid way to run, so the list is empty rather than an error - and a write says why it
  // cannot happen, with a status the API can pass on.
  it("without server storage: lists nothing and refuses writes with 503", async () => {
    enabled = false;
    expect(isSharedStoreAvailable()).toBe(false);
    expect(await listSharedDatasources()).toEqual([]);
    expect(await status(createSharedDatasource(valid, "admin"))).toBe(503);
  });

  it("creates under the reserved owner, in the encrypted connections collection, as managed", async () => {
    const record = await createSharedDatasource(valid, "admin@example.test");
    expect(record.managed).toBe(true);
    expect(record.createdBy).toBe("admin@example.test");
    expect(record.updatedBy).toBe("admin@example.test");
    expect(record.createdAt).toBe(record.updatedAt);
    expect(Object.keys(rows)).toEqual([`${SHARED_DATASOURCES_OWNER}/connections`]);
    expect(await listSharedDatasources()).toEqual([record]);
  });

  it("validates with the seed schema and names the field", async () => {
    try {
      await createSharedDatasource({ ...valid, id: "Not Valid", roles: [] }, "admin");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("id: ");
      expect((err as Error).message).toContain("roles: ");
      expect((err as InstanceType<typeof SharedDatasourceError>).statusCode).toBe(400);
    }
    expect(await status(createSharedDatasource("nope", "admin"))).toBe(400);
  });

  it("refuses a duplicate id with 409", async () => {
    await createSharedDatasource(valid, "admin");
    expect(await status(createSharedDatasource(valid, "admin"))).toBe(409);
  });

  // The admin API never returns a secret, so an edit that round-trips the view carries none;
  // saving it must keep the stored one. Sending a value replaces it.
  it("keeps the stored secrets when an update omits them, replaces them when sent", async () => {
    await createSharedDatasource(
      { ...valid, connectionString: "postgres://u:p@h/db", ssl: { mode: "verify-full", clientKey: "KEY" } },
      "admin",
    );
    const kept = await updateSharedDatasource(
      "prod-orders",
      { ...valid, name: "Orders", password: "", connectionString: undefined, ssl: { mode: "verify-full" } },
      "other@example.test",
    );
    expect(kept.name).toBe("Orders");
    expect(kept.password).toBe("hunter2");
    expect(kept.connectionString).toBe("postgres://u:p@h/db");
    expect(kept.ssl?.clientKey).toBe("KEY");
    expect(kept.createdBy).toBe("admin");
    expect(kept.updatedBy).toBe("other@example.test");

    const replaced = await updateSharedDatasource("prod-orders", { ...valid, password: "new" }, "admin");
    expect(replaced.password).toBe("new");
    expect(replaced.ssl).toBeUndefined();
  });

  it("updates by the id in the path, whatever the body says", async () => {
    await createSharedDatasource(valid, "admin");
    const record = await updateSharedDatasource("prod-orders", { ...valid, id: "something-else" }, "admin");
    expect(record.id).toBe("prod-orders");
    expect((await listSharedDatasources()).map((r) => r.id)).toEqual(["prod-orders"]);
  });

  it("answers 404 for an unknown id on update and delete, and a non-object update with 400", async () => {
    expect(await status(updateSharedDatasource("ghost", valid, "admin"))).toBe(404);
    expect(await status(deleteSharedDatasource("ghost"))).toBe(404);
    expect(await status(updateSharedDatasource("ghost", 42, "admin"))).toBe(400);
  });

  it("deletes and returns what was removed", async () => {
    await createSharedDatasource(valid, "admin");
    const removed = await deleteSharedDatasource("prod-orders");
    expect(removed.name).toBe(valid.name);
    expect(await listSharedDatasources()).toEqual([]);
  });

  // Read on every resolveConnection, so a read is served from memory for a few seconds, and
  // a write in this process refreshes what the next read sees rather than waiting it out.
  it("caches reads and refreshes the cache on write", async () => {
    await listSharedDatasources();
    await listSharedDatasources();
    expect(reads).toBe(1);
    await createSharedDatasource(valid, "admin");
    expect((await listSharedDatasources()).map((r) => r.id)).toEqual(["prod-orders"]);
    expect(reads).toBe(1);
  });

  // What leaves the server: every secret replaced by a fact about it, so the edit form can
  // show "a password is set" or "references ${DB_PASS}" without ever holding the value.
  it("the view carries no secret, only whether one is set and which variable it references", async () => {
    const record = await createSharedDatasource(
      {
        ...valid,
        password: "${DB_PASS}",
        connectionString: "x",
        ssl: { mode: "require", clientKey: "K", caCert: "CA" },
      },
      "admin",
    );
    const view = toSharedDatasourceView(record);
    expect(view).not.toHaveProperty("password");
    expect(view).not.toHaveProperty("connectionString");
    expect(view.ssl).toEqual({ mode: "require", caCert: "CA" });
    expect(view.hasPassword).toBe(true);
    expect(view.passwordEnv).toBe("DB_PASS");
    expect(view.hasConnectionString).toBe(true);

    const bare = toSharedDatasourceView(
      await createSharedDatasource({ ...valid, id: "bare", password: undefined }, "a"),
    );
    expect(bare.hasPassword).toBe(false);
    expect(bare).not.toHaveProperty("passwordEnv");
    expect(bare).not.toHaveProperty("ssl");

    // docs/CONTEXT.md §4.5: a Vault reference is named as such - it is a pointer, not a value.
    const vault = toSharedDatasourceView(
      await createSharedDatasource({ ...valid, id: "vault", password: "vault:db:database/orders" }, "a"),
    );
    expect(vault.hasPassword).toBe(true);
    expect(vault.passwordVault).toBe("vault:db:database/orders");
    expect(vault).not.toHaveProperty("passwordEnv");
  });
});
