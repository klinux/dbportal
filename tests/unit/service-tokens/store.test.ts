import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Service tokens (docs/CONTEXT.md §4.10): a secret minted once and kept only as a hash; a
 * live token resolved from its Bearer in constant time; revocation that keeps the row for
 * the audit trail; the view that never carries the hash. The storage provider is mocked.
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

const {
  SECRET_PREFIX,
  TOUCH_INTERVAL_MS,
  ServiceTokenError,
  actorOf,
  authenticateServiceToken,
  createServiceToken,
  findServiceTokenByActor,
  hashSecret,
  listServiceTokens,
  resetServiceTokenCache,
  revokeServiceToken,
  toServiceTokenView,
  touchServiceToken,
} = await import("@/lib/service-tokens/store");

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof ServiceTokenError ? e.statusCode : -1;
  }
};

describe("service-tokens store", () => {
  beforeEach(() => {
    resetServiceTokenCache();
    serverStorage = true;
    rows = [];
    provider.getCollection.mockClear();
    provider.setCollection.mockClear();
  });

  test("creates a token whose secret is returned once and stored only as a hash, under the reserved owner", async () => {
    const { record, secret } = await createServiceToken(
      { name: "slack-bot", groups: ["sre", " sre ", ""], datasources: ["orders"], requireApproval: true },
      "root",
    );
    expect(secret.startsWith(SECRET_PREFIX)).toBe(true);
    expect(secret.length).toBe(SECRET_PREFIX.length + 32);
    expect(record.secretHash).toBe(hashSecret(secret));
    expect(record.prefix).toBe(secret.slice(0, SECRET_PREFIX.length + 6));
    expect(record).toMatchObject({
      name: "slack-bot",
      role: "user",
      groups: ["sre"],
      datasources: ["orders"],
      requireApproval: true,
      createdBy: "root",
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(provider.setCollection.mock.calls[0]?.slice(0, 2)).toEqual(["shared:service-tokens", "service_tokens"]);
    expect(actorOf(record)).toBe("svc:slack-bot");
    // The defaults: a user, no groups, no allowlist, review only what the datasource demands.
    const plain = (await createServiceToken({ name: "plain" }, "root")).record;
    expect(plain).toMatchObject({ role: "user", requireApproval: false });
    expect(plain).not.toHaveProperty("groups");
    expect(plain).not.toHaveProperty("datasources");
    // Trusted approvals is opt-in and absent by default: a token that never asked for it
    // must not be able to declare approvers, and an old record without the key means "no".
    expect(plain).not.toHaveProperty("trustedApprovals");
    const trusted = (await createServiceToken({ name: "trusted", trustedApprovals: true }, "root")).record;
    expect(trusted.trustedApprovals).toBe(true);
    // Only the boolean true grants it; a truthy string is not a grant.
    const lax = (await createServiceToken({ name: "lax", trustedApprovals: "yes" }, "root")).record;
    expect(lax).not.toHaveProperty("trustedApprovals");
  });

  test("refuses a bad name, a bad role, a non-list, a malformed datasource id, a non-object, and a duplicate live name", async () => {
    expect(await status(createServiceToken({ name: "Not Valid" }, "root"))).toBe(400);
    expect(await status(createServiceToken({ name: "ok", role: "root" }, "root"))).toBe(400);
    expect(await status(createServiceToken({ name: "ok", groups: "sre" }, "root"))).toBe(400);
    expect(await status(createServiceToken({ name: "ok", datasources: ["Not Valid"] }, "root"))).toBe(400);
    expect(await status(createServiceToken("nope", "root"))).toBe(400);
    await createServiceToken({ name: "dup" }, "root");
    expect(await status(createServiceToken({ name: "dup" }, "root"))).toBe(409);
  });

  test("authenticates a live secret in constant time, and neither a wrong one, a foreign shape, nor a revoked one", async () => {
    const a = await createServiceToken({ name: "a", role: "admin", groups: ["ops"] }, "root");
    const b = await createServiceToken({ name: "b" }, "root");
    const identity = await authenticateServiceToken(a.secret);
    expect(identity?.token.id).toBe(a.record.id);
    expect(identity?.session).toEqual({ role: "admin", username: "svc:a", groups: ["ops"] });
    expect((await authenticateServiceToken(b.secret))?.session).toEqual({ role: "user", username: "svc:b" });
    expect(await authenticateServiceToken(`${SECRET_PREFIX}${"x".repeat(32)}`)).toBeNull();
    expect(await authenticateServiceToken("Bearer nothing")).toBeNull();
    await revokeServiceToken(a.record.id, "root");
    expect(await authenticateServiceToken(a.secret)).toBeNull();
  });

  test("revoking keeps the row with who and when, refuses twice, and 404s an unknown id", async () => {
    const { record } = await createServiceToken({ name: "old" }, "root");
    const revoked = await revokeServiceToken(record.id, "ana");
    expect(revoked).toMatchObject({ id: record.id, revokedBy: "ana" });
    expect(typeof revoked.revokedAt).toBe("string");
    expect((await listServiceTokens()).map((t) => t.name)).toEqual(["old"]);
    expect(await status(revokeServiceToken(record.id, "ana"))).toBe(409);
    expect(await status(revokeServiceToken("ghost", "ana"))).toBe(404);
    // A revoked name may be reused: the live-name check ignores revoked rows.
    expect(await status(createServiceToken({ name: "old" }, "root"))).toBe(200);
  });

  test("the view drops the hash and nothing else", async () => {
    const { record } = await createServiceToken({ name: "v" }, "root");
    const view = toServiceTokenView(record);
    expect(view).not.toHaveProperty("secretHash");
    expect(Object.keys(view).sort()).toEqual(
      Object.keys(record)
        .filter((k) => k !== "secretHash")
        .sort(),
    );
    expect(JSON.stringify(await listServiceTokens())).not.toContain("secretHash");
  });

  test("findServiceTokenByActor resolves a live svc: actor and nothing else", async () => {
    const { record } = await createServiceToken({ name: "bot", groups: ["g"] }, "root");
    expect((await findServiceTokenByActor("svc:bot"))?.session).toEqual({
      role: "user",
      username: "svc:bot",
      groups: ["g"],
    });
    expect(await findServiceTokenByActor("ana")).toBeNull();
    expect(await findServiceTokenByActor("svc:nobody")).toBeNull();
    await revokeServiceToken(record.id, "root");
    expect(await findServiceTokenByActor("svc:bot")).toBeNull();
  });

  test("touch stamps last use at most once per interval, and ignores an unknown id", async () => {
    const { record } = await createServiceToken({ name: "t" }, "root");
    const writes = provider.setCollection.mock.calls.length;
    await touchServiceToken(record.id);
    expect(provider.setCollection.mock.calls.length).toBe(writes + 1);
    const first = (await listServiceTokens())[0].lastUsedAt;
    expect(typeof first).toBe("string");
    await touchServiceToken(record.id);
    expect(provider.setCollection.mock.calls.length).toBe(writes + 1);
    // Past the interval, it is written again.
    rows = (rows as { id: string; lastUsedAt?: string }[]).map((r) =>
      r.id === record.id ? { ...r, lastUsedAt: new Date(Date.now() - TOUCH_INTERVAL_MS - 1).toISOString() } : r,
    );
    resetServiceTokenCache();
    await touchServiceToken(record.id);
    expect(provider.setCollection.mock.calls.length).toBe(writes + 2);
    await touchServiceToken("ghost");
    expect(provider.setCollection.mock.calls.length).toBe(writes + 2);
  });

  test("the cache serves reads for five seconds; an empty store is an empty list; no server store means no tokens and a 503 on write", async () => {
    await listServiceTokens();
    await listServiceTokens();
    expect(provider.getCollection).toHaveBeenCalledTimes(1);
    resetServiceTokenCache();
    rows = null;
    expect(await listServiceTokens()).toEqual([]);
    serverStorage = false;
    resetServiceTokenCache();
    expect(await listServiceTokens()).toEqual([]);
    expect(await authenticateServiceToken(`${SECRET_PREFIX}${"y".repeat(32)}`)).toBeNull();
    expect(await status(createServiceToken({ name: "x" }, "root"))).toBe(503);
  });
});
