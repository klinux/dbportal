import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockProvider } from "../../helpers/mock-provider";

const mockAuditRoleDenial = mock(() => {});
mock.module("@/lib/api/role-denial", () => ({ auditRoleDenial: mockAuditRoleDenial }));

const { assertObjectsAllowed } = await import("@/lib/api/object-gate");
const { SeedConnectionError } = await import("@/lib/seed/resolve-connection");

/**
 * The execution routes' object gate (docs/CONTEXT.md §4.56): a statement naming an object
 * the rules keep from this session is refused with 403 and audited as `object_forbidden`,
 * beside the write gate; a datasource without rules, or an administrator, passes.
 */
const connection = {
  id: "seed:orders",
  name: "Orders",
  type: "postgres" as const,
  createdAt: new Date(),
  objectRules: [{ match: "public.orders", roles: ["user"] }],
};

function provider() {
  return createMockProvider({
    containers: [{ path: ["public"], name: "public", level: 0, isSessionDefault: true }],
    capabilities: { containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }] },
  });
}

describe("assertObjectsAllowed", () => {
  beforeEach(() => mockAuditRoleDenial.mockClear());

  test("passes a datasource without rules, and an administrator on one with rules", async () => {
    const request = new Request("http://localhost/api/db/query", { method: "POST" });
    await assertObjectsAllowed({
      route: "POST /api/db/query",
      session: { role: "user", username: "ada" },
      connection: { ...connection, objectRules: undefined },
      statements: ["SELECT * FROM secret"],
      request,
      provider: provider(),
    });
    await assertObjectsAllowed({
      route: "POST /api/db/query",
      session: { role: "admin", username: "root" },
      connection,
      statements: ["SELECT * FROM secret"],
      request,
      provider: provider(),
    });
    expect(mockAuditRoleDenial).toHaveBeenCalledTimes(0);
  });

  test("passes a statement inside the scope, placing an unqualified name in the session's default schema", async () => {
    await assertObjectsAllowed({
      route: "POST /api/db/query",
      session: { role: "user", username: "ada" },
      connection,
      statements: ["SELECT * FROM orders"],
      request: new Request("http://localhost/api/db/query", { method: "POST" }),
      provider: provider(),
    });
    expect(mockAuditRoleDenial).toHaveBeenCalledTimes(0);
  });

  test("refuses with 403 and audits object_forbidden", async () => {
    const request = new Request("http://localhost/api/db/query", { method: "POST" });
    const failure = assertObjectsAllowed({
      route: "POST /api/db/query",
      session: { role: "user", username: "ada" },
      connection,
      statements: ["SELECT * FROM public.secrets"],
      request,
      provider: provider(),
    });
    await expect(failure).rejects.toBeInstanceOf(SeedConnectionError);
    await expect(failure).rejects.toMatchObject({ statusCode: 403 });
    await expect(failure).rejects.toThrow('"public.secrets" is not an object you may use on "Orders".');
    expect(mockAuditRoleDenial).toHaveBeenCalledWith({
      route: "POST /api/db/query",
      user: "ada",
      request,
      reason: "object_forbidden",
    });
  });
});
