import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * The SSH profile store (docs/CONTEXT.md §4.9): two sources merged into one list, the seed
 * file's read-only and first; a secret kept across an edit that omits it; a delete refused
 * while a datasource names the profile; and a view that never carries a secret. The
 * storage provider, the seed file and the datasource store are mocked.
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
let declaredProfiles: unknown[] = [];
let declaredConnections: unknown[] = [];
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({ version: "1", connections: declaredConnections, sshProfiles: declaredProfiles }),
}));
let sharedDatasources: unknown[] = [];
mock.module("@/lib/datasources/store", () => ({
  // The draft test's loan of a stored secret (§4.48) is not this file's subject: a draft passes through.
  withStoredSecret: async (draft: unknown) => draft,
  listSharedDatasources: async () => sharedDatasources,
}));

const {
  createSshProfile,
  updateSshProfile,
  deleteSshProfile,
  listSshProfiles,
  listSshProfileViews,
  findSshProfile,
  datasourcesUsing,
  toSshProfileView,
  resetSshProfileCache,
  SshProfileError,
} = await import("@/lib/ssh-profiles/store");

const input = {
  id: "prod-bastion",
  name: "Production bastion",
  host: "bastion.internal",
  username: "portal",
  authMethod: "privateKey",
  privateKey: "-----BEGIN KEY-----",
  passphrase: "hunter2",
};
const declared = {
  id: "seed-bastion",
  name: "Seed bastion",
  host: "seed.internal",
  port: 22,
  username: "ops",
  authMethod: "password",
  password: "${SEED_PW}",
};

describe("ssh-profiles store", () => {
  beforeEach(() => {
    resetSshProfileCache();
    serverStorage = true;
    rows = [];
    declaredProfiles = [];
    declaredConnections = [];
    sharedDatasources = [];
    provider.getCollection.mockClear();
    provider.setCollection.mockClear();
  });

  test("creates a profile under the reserved owner with the schema's defaults and the actor's stamps", async () => {
    const record = await createSshProfile(input, "root");
    expect(record).toMatchObject({ ...input, port: 22, createdBy: "root", updatedBy: "root" });
    expect(provider.setCollection).toHaveBeenCalledWith("shared:ssh-profiles", "ssh_profiles", [record]);
    expect(await findSshProfile("prod-bastion")).toEqual(record);
  });

  test("refuses an invalid body with 400 that names the field, and a taken id with 409", async () => {
    const bad = await createSshProfile({ ...input, id: "Not Valid" }, "root").catch((e) => e);
    expect(bad).toBeInstanceOf(SshProfileError);
    expect(bad.statusCode).toBe(400);
    expect(bad.message).toContain("id");
    await createSshProfile(input, "root");
    const dup = await createSshProfile(input, "root").catch((e) => e);
    expect(dup.statusCode).toBe(409);
    expect(dup.message).toContain("already exists");
  });

  test("refuses to shadow a profile the seed file declares, with 409 that says where to edit it", async () => {
    declaredProfiles = [declared];
    const err = await createSshProfile({ ...input, id: "seed-bastion" }, "root").catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("seed file");
  });

  test("lists the seed file's profiles first and skips a stored record that shares an id", async () => {
    declaredProfiles = [declared];
    rows = [
      { ...declared, name: "Shadow", createdAt: "x", updatedAt: "x", createdBy: "a", updatedBy: "a" },
      { ...input, port: 22, createdAt: "x", updatedAt: "x", createdBy: "a", updatedBy: "a" },
    ];
    const list = await listSshProfiles();
    expect(list.map((e) => [e.profile.id, e.source, e.profile.name])).toEqual([
      ["seed-bastion", "config", "Seed bastion"],
      ["prod-bastion", "store", "Production bastion"],
    ]);
  });

  // The API never returns a secret, so a round-tripped edit arrives without it: the stored
  // one must survive, and a typed one must replace it.
  test("an update keeps a secret left blank and replaces one that was typed", async () => {
    const created = await createSshProfile(input, "root");
    const kept = await updateSshProfile(
      "prod-bastion",
      { ...input, name: "Renamed", privateKey: "", passphrase: undefined },
      "ana",
    );
    expect(kept.name).toBe("Renamed");
    expect(kept.privateKey).toBe("-----BEGIN KEY-----");
    expect(kept.passphrase).toBe("hunter2");
    expect(kept.createdAt).toBe(created.createdAt);
    expect(kept.updatedBy).toBe("ana");
    const replaced = await updateSshProfile("prod-bastion", { ...input, privateKey: "NEW" }, "ana");
    expect(replaced.privateKey).toBe("NEW");
    // The id in the path wins over one in the body: a body cannot rename a record.
    const renamed = await updateSshProfile("prod-bastion", { ...input, id: "other" }, "ana");
    expect(renamed.id).toBe("prod-bastion");
  });

  test("updating or deleting an unknown profile is 404; a non-object update body is 400", async () => {
    expect((await updateSshProfile("ghost", input, "root").catch((e) => e)).statusCode).toBe(404);
    expect((await deleteSshProfile("ghost").catch((e) => e)).statusCode).toBe(404);
    expect((await updateSshProfile("ghost", "nope", "root").catch((e) => e)).statusCode).toBe(400);
  });

  test("a delete is refused with 409 while a datasource - from the seed file or the store - names the profile", async () => {
    await createSshProfile(input, "root");
    declaredConnections = [
      { id: "yaml-db", sshProfile: "prod-bastion" },
      { id: "other", sshProfile: "x" },
    ];
    sharedDatasources = [{ id: "store-db", sshProfile: "prod-bastion" }, { id: "plain" }];
    expect(await datasourcesUsing("prod-bastion")).toEqual(["yaml-db", "store-db"]);
    const err = await deleteSshProfile("prod-bastion").catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("yaml-db, store-db");
    declaredConnections = [];
    sharedDatasources = [];
    expect((await deleteSshProfile("prod-bastion")).id).toBe("prod-bastion");
    expect(rows).toEqual([]);
  });

  test("the cache serves reads for five seconds and a write refreshes it", async () => {
    await listSshProfiles();
    await listSshProfiles();
    expect(provider.getCollection).toHaveBeenCalledTimes(1);
    await createSshProfile(input, "root");
    expect((await listSshProfiles()).length).toBe(1);
    expect(provider.getCollection).toHaveBeenCalledTimes(1);
    // A store that has nothing yet answers null; that is an empty list, not a crash.
    resetSshProfileCache();
    rows = null;
    expect(await listSshProfiles()).toEqual([]);
  });

  test("without server storage the seed file's profiles still list, and a write is 503 that names the setting", async () => {
    serverStorage = false;
    declaredProfiles = [declared];
    expect((await listSshProfiles()).map((e) => e.profile.id)).toEqual(["seed-bastion"]);
    const err = await createSshProfile(input, "root").catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("STORAGE_PROVIDER");
  });

  // What leaves the server: facts about the secrets, and a reference when that is what is stored.
  test("a view carries no secret value, says which are set, and shows a reference as a reference", async () => {
    const record = await createSshProfile(input, "root");
    const view = toSshProfileView(record, "store");
    expect(JSON.stringify(view)).not.toContain("BEGIN KEY");
    expect(JSON.stringify(view)).not.toContain("hunter2");
    expect(view).toMatchObject({
      source: "store",
      hasPassword: false,
      hasPrivateKey: true,
      hasPassphrase: true,
      updatedBy: "root",
    });
    expect(view).not.toHaveProperty("privateKeyRef");

    declaredProfiles = [declared, { ...declared, id: "vault-b", password: "vault:kv:secret/b#pw" }];
    const views = await listSshProfileViews();
    expect(views[0]).toMatchObject({ source: "config", hasPassword: true, passwordRef: "${SEED_PW}" });
    expect(views[0]).not.toHaveProperty("createdAt");
    expect(views[1].passwordRef).toBe("vault:kv:secret/b#pw");
    expect(JSON.stringify(views)).not.toContain('"password":');
  });
});
