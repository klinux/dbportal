import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The caller's own SSH identity over the API (docs/CONTEXT.md §4.9): administrators only,
 * always the session's own owner, a view and never a key, the store's refusals in its own
 * status, and an audit line on a save or a removal that names no secret.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "ana@example.test" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));

const realStore = { ...(await import("@/lib/ssh-identity/store")) };
let stored: { username: string; privateKey: string; passphrase?: string; updatedAt: string } | null = null;
let storeDown = false;
mock.module("@/lib/ssh-identity/store", () => ({
  ...realStore,
  getSshIdentity: async (owner: string) => {
    if (storeDown) throw new realStore.SshIdentityError("no store", 503);
    return owner === "ana@example.test" ? stored : null;
  },
  putSshIdentity: async (owner: string, input: { username: string; privateKey?: string }) => {
    if (input.username === "bad") throw new realStore.SshIdentityError("Invalid SSH identity: bad", 400);
    if (input.username === "boom") throw new Error("disk");
    stored = { username: input.username, privateKey: input.privateKey ?? "kept", updatedAt: "x" };
    return stored;
  },
  deleteSshIdentity: async (_owner: string) => {
    if (storeDown) throw new realStore.SshIdentityError("no store", 503);
    const had = stored !== null;
    stored = null;
    return had;
  },
}));

const { GET, PUT, DELETE } = await import("@/app/api/me/ssh-identity/route");
const url = "http://localhost/api/me/ssh-identity";
const json = (body: unknown, method = "PUT") =>
  new Request(url, { method, headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });

describe("/api/me/ssh-identity", () => {
  beforeEach(() => {
    session = { role: "admin", username: "ana@example.test" };
    stored = null;
    storeDown = false;
    audit.mockClear();
  });

  test("a user or nobody is refused; only an administrator reaches the store", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await PUT(json({ username: "bob", privateKey: "k" }))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE", headers: { origin: "http://localhost" } }))).status).toBe(403);
    // No session at all is the same gate's 403, as on every admin route.
    session = null;
    expect((await GET(new Request(url))).status).toBe(403);
  });

  test("GET answers the view, null when there is none, and never the key", async () => {
    expect(await (await GET(new Request(url))).json()).toEqual({ identity: null });
    stored = { username: "ana_example_com", privateKey: "SECRET-KEY", passphrase: "p", updatedAt: "x" };
    const res = await GET(new Request(url));
    const body = await res.json();
    expect(body).toEqual({ identity: { username: "ana_example_com", hasPrivateKey: true, hasPassphrase: true, updatedAt: "x" } });
    expect(JSON.stringify(body)).not.toContain("SECRET-KEY");
  });

  test("PUT saves for the caller and audits it without the key; the store's refusal keeps its status", async () => {
    const res = await PUT(json({ username: "ana_example_com", privateKey: "SECRET-KEY" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identity: { username: "ana_example_com", hasPrivateKey: true } });
    expect(audit).toHaveBeenCalledTimes(1);
    const line = audit.mock.calls[0][0];
    expect(line).toMatchObject({ type: "ssh_identity", action: "updated", user: "ana@example.test", result: "success" });
    expect(JSON.stringify(line)).not.toContain("SECRET-KEY");
    expect((await PUT(json({ username: "bad", privateKey: "k" }))).status).toBe(400);
    expect((await PUT(new Request(url, { method: "PUT", headers: { origin: "http://localhost" }, body: "[]" }))).status).toBe(400);
    expect((await PUT(json({ username: "boom", privateKey: "k" }))).status).toBe(500);
    storeDown = true;
    expect((await GET(new Request(url))).status).toBe(503);
  });

  test("DELETE removes the caller's identity and audits only when there was one", async () => {
    const none = await DELETE(new Request(url, { method: "DELETE", headers: { origin: "http://localhost" } }));
    expect(await none.json()).toEqual({ ok: true, removed: false });
    expect(audit).not.toHaveBeenCalled();
    stored = { username: "ana", privateKey: "k", updatedAt: "x" };
    const gone = await DELETE(new Request(url, { method: "DELETE", headers: { origin: "http://localhost" } }));
    expect(await gone.json()).toEqual({ ok: true, removed: true });
    expect(audit.mock.calls[0][0]).toMatchObject({ type: "ssh_identity", action: "deleted" });
    storeDown = true;
    expect((await DELETE(new Request(url, { method: "DELETE", headers: { origin: "http://localhost" } }))).status).toBe(503);
  });
});
