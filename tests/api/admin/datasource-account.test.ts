/**
 * The two account routes: admin only, the body read once by the shared helper, the
 * provisioning module called with the session's actor, and its answers passed through -
 * a plan as 200, a completed run as 200, a stopped run as 409, a refusal with its own
 * status.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";

let session: { role: string; username: string } | null = { role: "admin", username: "root" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));

class ProvisionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}
mock.module("@/lib/provisioning/errors", () => ({ ProvisionError }));
const inspectAccount = mock(async (_input: Record<string, unknown>) => ({
  inventory: { bootstrapUser: "app" },
  plan: { roleName: "dbportal_shop", agentRoleName: "dbportal_shop_agent", statements: [], blockers: [] },
  destination: { kind: "vault", mount: "dbportal", path: "datasources/shop" },
}));
const provisionAccount = mock(
  async (_input: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    roleName: "dbportal_shop",
    agentRoleName: null,
    statements: [],
    completed: true,
    destination: { kind: "vault", mount: "dbportal", path: "datasources/shop" },
  }),
);
mock.module("@/lib/provisioning/run", () => ({ inspectAccount, provisionAccount }));

const { POST: plan } = await import("@/app/api/admin/datasources/[id]/account/plan/route");
const { POST: run } = await import("@/app/api/admin/datasources/[id]/account/route");

const params = { params: Promise.resolve({ id: "shop" }) };
const post = (handler: typeof plan, body: unknown) =>
  handler(
    new Request("http://localhost/api/admin/datasources/shop/account", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params,
  );

beforeEach(() => {
  session = { role: "admin", username: "root" };
  clearRateLimitState();
  audit.mockClear();
  inspectAccount.mockClear();
  provisionAccount.mockClear();
});

describe("the account routes", () => {
  test("refuse a non-admin session on both routes, and audit the denial", async () => {
    session = { role: "user", username: "bob" };
    expect((await post(plan, { profile: "read" })).status).toBe(403);
    expect((await post(run, { profile: "read" })).status).toBe(403);
    expect(inspectAccount).not.toHaveBeenCalled();
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalled();
  });

  test("refuse a request with no session, even one that carries no route context", async () => {
    session = null;
    expect((await post(plan, { profile: "read" })).status).toBe(401);
    const bare = new Request("http://localhost/api/admin/datasources/shop/account", { method: "POST", body: "{}" });
    expect((await run(bare, undefined as never)).status).toBe(401);
  });

  test("the plan route answers the inspection for the datasource in the path, as the session's actor", async () => {
    const res = await post(plan, { profile: "read", schemas: ["sales"], bootstrap: { user: "dba", password: "s" } });

    expect(res.status).toBe(200);
    expect((await res.json()).plan.roleName).toBe("dbportal_shop");
    expect(inspectAccount).toHaveBeenCalledWith({
      datasourceId: "shop",
      request: { profile: "read", schemas: ["sales"], agent: false },
      bootstrap: { user: "dba", password: "s" },
      vaultPath: undefined,
      actor: "root",
    });
  });

  test("the run route answers 200 for a completed run and 409 for one that stopped", async () => {
    expect((await post(run, { profile: "readwrite", schemas: ["sales"], agent: true })).status).toBe(200);
    expect(provisionAccount.mock.calls[0][0]).toMatchObject({
      datasourceId: "shop",
      request: { profile: "readwrite", schemas: ["sales"], agent: true },
    });

    provisionAccount.mockImplementationOnce(async () => ({
      roleName: "dbportal_shop",
      agentRoleName: null,
      statements: [{ shown: "GRANT ...", purpose: "x", account: "portal", outcome: "refused", error: "denied" }],
      completed: false,
      destination: { kind: "store" },
    }));
    const stopped = await post(run, { profile: "read", schemas: ["sales"] });
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).completed).toBe(false);
  });

  test("answer a malformed body and an empty body as the helper's 400", async () => {
    expect((await post(plan, "not json")).status).toBe(400);
    const res = await post(run, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("profile");
  });

  test("pass a refusal through with its own status", async () => {
    inspectAccount.mockImplementationOnce(async () => {
      throw new ProvisionError("The plan cannot run yet", 409);
    });
    const res = await post(plan, { profile: "read" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The plan cannot run yet");
  });
});
