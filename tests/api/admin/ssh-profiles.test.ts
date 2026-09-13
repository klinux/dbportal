import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The admin CRUD for SSH profiles (docs/CONTEXT.md §4.9). The store is mocked -
 * tests/unit/ssh-profiles/store.test.ts owns its behaviour - so what is proven here is the
 * gate, the bodies, the statuses the store's refusals turn into, the audit line each
 * mutation leaves, and that no response carries a secret.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root@example.test" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const mockEmitAuditEvent = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));

class SshProfileError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const record = {
  id: "prod-bastion",
  name: "Production bastion",
  host: "bastion.internal",
  port: 22,
  username: "portal",
  authMethod: "privateKey",
  privateKey: "-----BEGIN KEY-----",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  createdBy: "root@example.test",
  updatedBy: "root@example.test",
};
const view = (r: typeof record, source: string) => ({
  ...Object.fromEntries(Object.entries(r).filter(([k]) => !["privateKey", "password", "passphrase"].includes(k))),
  source,
  hasPassword: false,
  hasPrivateKey: !!r.privateKey,
  hasPassphrase: false,
});
const store = {
  create: mock(async () => record),
  update: mock(async () => record),
  remove: mock(async () => record),
  list: mock(async () => [view(record, "store")]),
};
mock.module("@/lib/ssh-profiles/store", () => ({
  SshProfileError,
  findSshProfile: async () => null,
  listSshProfileViews: () => store.list(),
  createSshProfile: (...args: unknown[]) => store.create(...(args as [])),
  updateSshProfile: (...args: unknown[]) => store.update(...(args as [])),
  deleteSshProfile: (...args: unknown[]) => store.remove(...(args as [])),
  toSshProfileView: view,
}));

const { GET, POST } = await import("@/app/api/admin/ssh-profiles/route");
const { PUT, DELETE } = await import("@/app/api/admin/ssh-profiles/[id]/route");

const url = "http://localhost/api/admin/ssh-profiles";
const json = (method: string, body: unknown) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const audited = () => mockEmitAuditEvent.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("/api/admin/ssh-profiles", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    mockEmitAuditEvent.mockClear();
    for (const fn of Object.values(store)) fn.mockClear();
    store.create.mockImplementation(async () => record);
    store.update.mockImplementation(async () => record);
    store.remove.mockImplementation(async () => record);
    store.list.mockImplementation(async () => [view(record, "store")]);
  });

  test("every handler is admin-only, and a non-admin probe is audited as a role denial", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json("POST", record))).status).toBe(403);
    expect((await PUT(json("PUT", record), params("prod-bastion"))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("prod-bastion"))).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
    expect(audited().length).toBe(4);
    for (const event of audited()) {
      expect(event.type).toBe("permission_denied");
      expect(event.reason).toBe("insufficient_role");
    }
  });

  test("GET lists the views the store built, secrets absent", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profiles[0]).toMatchObject({ id: "prod-bastion", source: "store", hasPrivateKey: true });
    expect(JSON.stringify(body)).not.toContain("BEGIN KEY");
  });

  test("POST creates with the session's username as actor, answers 201 with the view, and audits it", async () => {
    const res = await POST(json("POST", { ...record, passphrase: "hunter2" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.profile.id).toBe("prod-bastion");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("BEGIN KEY");
    expect((store.create.mock.calls[0] as unknown[])[1]).toBe("root@example.test");
    expect(audited()[0]).toMatchObject({
      type: "ssh_profile",
      action: "created",
      target: "prod-bastion",
      result: "success",
    });
  });

  test("PUT updates the profile the path names and DELETE removes it, each audited", async () => {
    expect((await PUT(json("PUT", record), params("prod-bastion"))).status).toBe(200);
    expect((store.update.mock.calls[0] as unknown[])[0]).toBe("prod-bastion");
    const del = await DELETE(new Request(url, { method: "DELETE" }), params("prod-bastion"));
    expect(await del.json()).toEqual({ deleted: "prod-bastion" });
    expect(audited().map((e) => e.action)).toEqual(["updated", "deleted"]);
  });

  test("a body that is not a JSON object is 400 on POST and PUT, and nothing is stored or audited", async () => {
    const bad = new Request(url, { method: "POST", body: "[]", headers: { "Content-Type": "application/json" } });
    expect((await POST(bad)).status).toBe(400);
    const badPut = new Request(url, { method: "PUT", body: "nope", headers: { "Content-Type": "application/json" } });
    expect((await PUT(badPut, params("prod-bastion"))).status).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(audited().length).toBe(0);
  });

  test("the store's refusals answer with their status and message; anything else goes through the shared mapper as 500", async () => {
    store.remove.mockImplementation(async () => {
      throw new SshProfileError('SSH profile "prod-bastion" is used by orders', 409);
    });
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("prod-bastion"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("used by orders");
    expect(audited().length).toBe(0);

    store.list.mockImplementation(async () => {
      throw new Error("disk on fire: /var/lib/secret");
    });
    const broken = await GET(new Request(url));
    expect(broken.status).toBe(500);
    expect((await broken.json()).code).toBe("INTERNAL_ERROR");
  });
});
