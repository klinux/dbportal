import { describe, test, expect, mock } from "bun:test";

/**
 * The known principals (docs/CONTEXT.md §4.37): the built-ins, every named role and its
 * members, every list of every datasource from both sources, every token's groups - each
 * once, with where it was seen first; a store that cannot be read costs its own entries only.
 */
let sharedFails = false;
mock.module("@/lib/roles/store", () => ({
  listNamedRoles: async () => [
    { role: { id: "oncall", name: "On-call", members: ["group:sre", "user:ana@example.test"] }, source: "store" },
  ],
}));
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({
    version: "1",
    connections: [
      { id: "orders", roles: ["*", "group:support"], writeRoles: ["role:oncall"], approverRoles: ["group:dba"] },
    ],
  }),
}));
mock.module("@/lib/datasources/store", () => ({
  listSharedDatasources: async () => {
    if (sharedFails) throw new Error("disk");
    return [{ id: "hr", roles: ["admin"], exportRoles: ["group:analysts", "nonsense"] }];
  },
}));
mock.module("@/lib/service-tokens/store", () => ({
  listServiceTokens: async () => [{ name: "slack-bot", groups: ["bots", "sre"] }],
}));

const { listKnownPrincipals, principalKind } = await import("@/lib/principals");

describe("known principals", () => {
  test("principalKind reads the shape, and null for anything else", () => {
    expect(principalKind("*")).toBe("wildcard");
    expect(principalKind("admin")).toBe("role");
    expect(principalKind("role:x")).toBe("named");
    expect(principalKind("group:x")).toBe("group");
    expect(principalKind("user:x")).toBe("user");
    expect(principalKind("nonsense")).toBeNull();
  });

  test("gathers each principal once with its first source, skipping what is not a principal", async () => {
    const list = await listKnownPrincipals();
    expect(list.map((p) => `${p.kind} ${p.id} <- ${p.source}`)).toEqual([
      "wildcard * <- built-in",
      "role admin <- built-in",
      "role user <- built-in",
      "named role:oncall <- role On-call",
      "group group:sre <- role On-call",
      "user user:ana@example.test <- role On-call",
      "group group:support <- datasource orders",
      "group group:dba <- datasource orders",
      "group group:analysts <- datasource hr",
      "group group:bots <- token slack-bot",
    ]);
    sharedFails = true;
    expect((await listKnownPrincipals()).some((p) => p.id === "group:analysts")).toBe(false);
  });
});
