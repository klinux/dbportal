import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * The Vault KV browser route (docs/CONTEXT.md §4.39): admin only, 503 without Vault, a
 * listing for `?path=`, a shaped secret for `?secret=` with an audit line, the malformed
 * path a 400, Vault's refusal a 502 that says nothing of what Vault said.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
// The real client, with only the configuration check swapped: other modules on the route's import path read the rest of it.
const client = await import("@/lib/vault/client");
const { VaultError } = client;
let configured = true;
mock.module("@/lib/vault/client", () => ({ ...client, isVaultConfigured: () => configured }));
const listing = { mount: "secret", path: "db", folders: ["staging"], secrets: ["orders"] };
const shaped = {
  path: "db/orders",
  keys: ["host", "password", "note"],
  fields: { host: "db.internal" },
  references: { password: "vault:kv:secret/db/orders#password" },
};
const browser = { browse: mock(async (_p: string) => listing), secret: mock(async (_p: string) => shaped) };
mock.module("@/lib/vault/kv-browser", () => ({
  browseKv: (p: string) => browser.browse(p),
  secretFields: (p: string) => browser.secret(p),
}));

const { GET } = await import("@/app/api/admin/vault/kv/route");
const get = (query: string) => GET(new Request(`http://localhost/api/admin/vault/kv${query}`));

describe("GET /api/admin/vault/kv", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root" };
    configured = true;
    audit.mockClear();
  });

  test("admin only, and 503 where Vault is not configured", async () => {
    session = { role: "user", username: "bob" };
    expect((await get("?path=db")).status).toBe(403);
    session = { role: "admin", username: "root" };
    configured = false;
    const res = await get("?path=db");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("not configured");
  });

  test("lists a path, and reads a secret shaped for the sheet with an audit line naming the path", async () => {
    expect(await (await get("?path=db%2F")).json()).toEqual(listing);
    expect(browser.browse).toHaveBeenLastCalledWith("db/");
    expect(await (await get("")).json()).toEqual(listing);
    expect(browser.browse).toHaveBeenLastCalledWith("");
    expect(audit).not.toHaveBeenCalled();
    expect(await (await get("?secret=db%2Forders")).json()).toEqual(shaped);
    expect(audit.mock.calls[0][0]).toMatchObject({
      type: "vault_secret",
      action: "read",
      target: "db/orders",
      user: "root",
      result: "success",
      details: "2 of 3 keys understood",
    });
  });

  test("a malformed path is a 400 with the reason; Vault's refusal a 502 without it; anything else a 500", async () => {
    browser.secret.mockImplementationOnce(async () => {
      throw new VaultError("The Vault path is malformed", 400);
    });
    const bad = await get("?secret=..");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("The Vault path is malformed");
    browser.browse.mockImplementationOnce(async () => {
      throw new VaultError("Vault answered 403 for secret/metadata/db", 403);
    });
    const refused = await get("?path=db");
    expect(refused.status).toBe(502);
    expect(JSON.stringify(await refused.json())).not.toContain("403");
    browser.browse.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect((await get("?path=db")).status).toBe(500);
  });
});
