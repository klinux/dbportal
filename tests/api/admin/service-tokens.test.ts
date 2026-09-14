import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * The admin routes for service tokens (docs/CONTEXT.md §4.10). The store is mocked -
 * tests/unit/service-tokens/store.test.ts owns it - so what is proven here is the gate,
 * the bodies, the one-time secret in the create response and nowhere else, the statuses
 * the store's refusals become, and the audit line each mutation leaves.
 */
let session: { role: string; username: string } | null = { role: "admin", username: "root@example.test" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const mockEmitAuditEvent = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));

class ServiceTokenError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
const record = {
  id: "tok-1",
  name: "slack-bot",
  role: "user",
  requireApproval: true,
  secretHash: "ab".repeat(32),
  prefix: "dbp_abcdef",
  createdAt: "2026-09-14T00:00:00.000Z",
  createdBy: "root@example.test",
};
const view = ({ secretHash, ...rest }: typeof record) => {
  void secretHash;
  return rest;
};
const store = {
  create: mock(async () => ({ record, secret: "dbp_the-secret-once" })),
  revoke: mock(async () => ({ ...record, revokedAt: "2026-09-14T01:00:00.000Z", revokedBy: "root@example.test" })),
  list: mock(async () => [view(record)]),
};
mock.module("@/lib/service-tokens/store", () => ({
  ServiceTokenError,
  listServiceTokens: () => store.list(),
  createServiceToken: (...args: unknown[]) => store.create(...(args as [])),
  revokeServiceToken: (...args: unknown[]) => store.revoke(...(args as [])),
  toServiceTokenView: view,
  authenticateServiceToken: async () => null,
  findServiceTokenByActor: async () => null,
  touchServiceToken: async () => {},
}));

const { GET, POST } = await import("@/app/api/admin/service-tokens/route");
const { DELETE } = await import("@/app/api/admin/service-tokens/[id]/route");

const url = "http://localhost/api/admin/service-tokens";
const json = (method: string, body: unknown) =>
  new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const audited = () => mockEmitAuditEvent.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("/api/admin/service-tokens", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root@example.test" };
    mockEmitAuditEvent.mockClear();
    for (const fn of Object.values(store)) fn.mockClear();
    store.create.mockImplementation(async () => ({ record, secret: "dbp_the-secret-once" }));
    store.revoke.mockImplementation(async () => ({ ...record, revokedAt: "x", revokedBy: "root@example.test" }));
    store.list.mockImplementation(async () => [view(record)]);
  });

  test("every handler is admin-only, and a non-admin probe is audited as a role denial", async () => {
    session = { role: "user", username: "bob" };
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(json("POST", { name: "x" }))).status).toBe(403);
    expect((await DELETE(new Request(url, { method: "DELETE" }), params("tok-1"))).status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
    expect(audited().length).toBe(3);
    for (const e of audited()) expect(e).toMatchObject({ type: "permission_denied", reason: "insufficient_role" });
  });

  test("GET lists views without hashes", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens[0].name).toBe("slack-bot");
    expect(JSON.stringify(body)).not.toContain("secretHash");
  });

  test("POST creates as the session's user, answers 201 with the view and the secret once, and audits by name", async () => {
    const res = await POST(json("POST", { name: "slack-bot", requireApproval: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret).toBe("dbp_the-secret-once");
    expect(body.token.name).toBe("slack-bot");
    expect(JSON.stringify(body.token)).not.toContain("secretHash");
    expect((store.create.mock.calls[0] as unknown[])[1]).toBe("root@example.test");
    expect(audited()[0]).toMatchObject({
      type: "service_token",
      action: "created",
      target: "slack-bot",
      result: "success",
    });
    // The secret never reaches the audit line.
    expect(JSON.stringify(audited())).not.toContain("the-secret");
  });

  test("DELETE revokes the token the path names and audits it", async () => {
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("tok-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).token.revokedBy).toBe("root@example.test");
    expect((store.revoke.mock.calls[0] as unknown[])[0]).toBe("tok-1");
    expect(audited()[0]).toMatchObject({ type: "service_token", action: "revoked", target: "slack-bot" });
  });

  test("a body that is not a JSON object is 400, and nothing is stored or audited", async () => {
    const bad = new Request(url, { method: "POST", body: "[]", headers: { "Content-Type": "application/json" } });
    expect((await POST(bad)).status).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
    expect(audited().length).toBe(0);
  });

  test("the store's refusals answer with their status and message; anything else goes through the shared mapper", async () => {
    store.revoke.mockImplementation(async () => {
      throw new ServiceTokenError('Service token "tok-1" is already revoked', 409);
    });
    const res = await DELETE(new Request(url, { method: "DELETE" }), params("tok-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already revoked");
    store.list.mockImplementation(async () => {
      throw new Error("disk");
    });
    expect((await GET(new Request(url))).status).toBe(500);
  });
});
