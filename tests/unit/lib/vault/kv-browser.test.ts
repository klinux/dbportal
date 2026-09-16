import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { VaultError, listKvKeys } from "@/lib/vault/client";
import { DEFAULT_KV_MOUNT, assertKvPath, browseKv, kvMount, secretFields } from "@/lib/vault/kv-browser";

/**
 * The KV browser behind the datasource sheet (docs/CONTEXT.md §4.39), over a mocked fetch:
 * the LIST call and its answer split into folders and secrets, a secret shaped for the
 * sheet - values for the plain fields, references for the credential - and the paths
 * refused before any request.
 */
type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("vault kv browser", () => {
  let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
  const env = {
    VAULT_ADDR: process.env.VAULT_ADDR,
    VAULT_TOKEN: process.env.VAULT_TOKEN,
    VAULT_KV_MOUNT: process.env.VAULT_KV_MOUNT,
  };

  beforeEach(() => {
    process.env.VAULT_ADDR = "https://vault.internal:8200";
    process.env.VAULT_TOKEN = "s.token";
    // Self-renewal is the client's own test; off here so the LIST is the first request.
    process.env.VAULT_TOKEN_RENEW = "off";
    delete process.env.VAULT_KV_MOUNT;
    fetchSpy = spyOn(holder, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("the mount is VAULT_KV_MOUNT or `secret`; a path is plain segments without `..` or a leading slash", () => {
    expect(kvMount()).toBe(DEFAULT_KV_MOUNT);
    process.env.VAULT_KV_MOUNT = " kv ";
    expect(kvMount()).toBe("kv");
    expect(assertKvPath("db/orders")).toBe("db/orders");
    expect(assertKvPath("")).toBe("");
    for (const bad of ["/db", "db//x", "db/../x", "..", "db?x", "db x", "db#k"]) {
      const err = (() => {
        try {
          assertKvPath(bad);
          return null;
        } catch (e) {
          return e as VaultError;
        }
      })();
      expect(err).toBeInstanceOf(VaultError);
      expect(err?.status).toBe(400);
    }
  });

  test("browsing lists a folder through LIST on the metadata path, folders apart from secrets; nothing there is an empty list", async () => {
    fetchSpy.mockImplementation(async () => json({ data: { keys: ["orders", "staging/", 7] } }));
    expect(await browseKv("db/")).toEqual({ mount: "secret", path: "db", folders: ["staging"], secrets: ["orders"] });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://vault.internal:8200/v1/secret/metadata/db?list=true");
    fetchSpy.mockImplementation(async () => json({ errors: [] }, 404));
    expect(await browseKv("")).toEqual({ mount: "secret", path: "", folders: [], secrets: [] });
    expect(fetchSpy.mock.calls[1][0]).toBe("https://vault.internal:8200/v1/secret/metadata?list=true");
    // Any other refusal is the client's error; an answer without keys is an empty list.
    fetchSpy.mockImplementation(async () => json({ errors: ["permission denied"] }, 403));
    await expect(listKvKeys("secret", "db")).rejects.toThrow("Vault answered 403");
    fetchSpy.mockImplementation(async () => json({ data: {} }));
    expect(await listKvKeys("secret", "db")).toEqual([]);
  });

  test("a secret is shaped for the sheet: plain fields as values by key name, the credential as a reference, and every key named", async () => {
    fetchSpy.mockImplementation(async () =>
      json({
        data: {
          data: { Host: "db.internal", PORT: 5432, username: "app", dbname: "orders", password: "hunter2", note: "x" },
        },
      }),
    );
    expect(await secretFields("db/orders")).toEqual({
      path: "db/orders",
      keys: ["Host", "PORT", "username", "dbname", "password", "note"],
      fields: { host: "db.internal", port: "5432", user: "app", database: "orders" },
      references: { password: "vault:kv:secret/db/orders#password" },
    });
    // The credential's value never leaves the server.
    expect(JSON.stringify(await secretFields("db/orders"))).not.toContain("hunter2");
    fetchSpy.mockImplementation(async () => json({ data: { data: { url: "postgres://x", host: { nested: true } } } }));
    expect(await secretFields("db/dsn")).toMatchObject({
      fields: {},
      references: { connectionString: "vault:kv:secret/db/dsn#url" },
    });
    // A folder or nothing names no secret.
    await expect(secretFields("db/")).rejects.toThrow("names no secret");
    await expect(secretFields("")).rejects.toThrow("names no secret");
  });
});
