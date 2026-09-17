import { describe, it, expect } from "bun:test";
import { filterByRoles, mergeDefaults } from "@/lib/seed/connection-filter";
import type { SeedConnection, SeedDefaults } from "@/lib/seed/types";

const baseConn: SeedConnection = {
  id: "test",
  name: "Test",
  type: "postgres",
  host: "localhost",
  roles: ["*"],
};

describe("mergeDefaults", () => {
  it("applies defaults when connection fields are missing", () => {
    const defaults: SeedDefaults = { managed: true, environment: "production" };
    const merged = mergeDefaults({ ...baseConn }, defaults);
    expect(merged.managed).toBe(true);
    expect(merged.environment).toBe("production");
  });

  it("connection-level values override defaults", () => {
    const defaults: SeedDefaults = { managed: true, environment: "production" };
    const merged = mergeDefaults({ ...baseConn, managed: false, environment: "staging" }, defaults);
    expect(merged.managed).toBe(false);
    expect(merged.environment).toBe("staging");
  });

  it("returns connection unchanged when no defaults", () => {
    const merged = mergeDefaults({ ...baseConn, managed: true }, undefined);
    expect(merged.managed).toBe(true);
  });

  it("merges ssl defaults", () => {
    const defaults: SeedDefaults = { ssl: { mode: "require", rejectUnauthorized: true } };
    const merged = mergeDefaults({ ...baseConn }, defaults);
    expect(merged.ssl).toEqual({ mode: "require", rejectUnauthorized: true });
  });

  it("connection ssl overrides default ssl", () => {
    const defaults: SeedDefaults = { ssl: { mode: "require" } };
    const merged = mergeDefaults({ ...baseConn, ssl: { mode: "disable" } }, defaults);
    expect(merged.ssl?.mode).toBe("disable");
  });
});

describe("filterByRoles: the no-scan choice", () => {
  it("carries a seeded connection's no-scan choice through to the managed connection", () => {
    // The second silent half (#765): this mapper is a hand-written field list, so a field
    // the schema validates and the mapper forgets reaches the browser as `undefined` and
    // the connection scans the catalog the deployment asked it not to.
    const [managed] = filterByRoles([{ ...baseConn, skipObjectScan: true }], ["admin"]);
    expect(managed.skipObjectScan).toBe(true);
  });

  // docs/CONTEXT.md §4.16: the limits travel, and the timeout limit is also the
  // connection's queryTimeout - the field the provider factory reads.
  it("carries the limits through, and makes the timeout limit the connection's queryTimeout", () => {
    const [managed] = filterByRoles([{ ...baseConn, limits: { maxRows: 5, queryTimeoutMs: 1234 } }], ["admin"]);
    expect(managed.limits).toEqual({ maxRows: 5, queryTimeoutMs: 1234 });
    expect(managed.queryTimeout).toBe(1234);
    const [plain] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(plain.limits).toBeUndefined();
    expect(plain.queryTimeout).toBeUndefined();
    const [rowsOnly] = filterByRoles([{ ...baseConn, limits: { maxRows: 5 } }], ["admin"]);
    expect(rowsOnly.queryTimeout).toBeUndefined();
  });

  it("carries the reviewer count through (§4.28)", () => {
    const [two] = filterByRoles([{ ...baseConn, approvalsRequired: 2 }], ["admin"]);
    expect(two.approvalsRequired).toBe(2);
    expect(filterByRoles([{ ...baseConn }], ["admin"])[0].approvalsRequired).toBeUndefined();
  });

  it("carries the export rule through (§4.22)", () => {
    const [strict] = filterByRoles([{ ...baseConn, exportRoles: [] }], ["admin"]);
    expect(strict.exportRoles).toEqual([]);
    const [plain] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(plain.exportRoles).toBeUndefined();
  });

  it("carries the ticket rule through (§4.18)", () => {
    const [strict] = filterByRoles([{ ...baseConn, requireTicket: true }], ["admin"]);
    expect(strict.requireTicket).toBe(true);
    const [plain] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(plain.requireTicket).toBeUndefined();
  });

  it("leaves it absent for a seed that does not ask for it", () => {
    const [managed] = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(managed.skipObjectScan).toBeUndefined();
  });
});

describe("filterByRoles: engine-specific fields", () => {
  it("carries a Cassandra connection's data centre through to the managed connection", () => {
    // The one field `cassandra-driver` refuses to start without. Dropped here, a
    // seeded ring would be a connection the product lists and cannot open - which is
    // exactly what a hand-written mapping loses silently.
    const [managed] = filterByRoles(
      [{ ...baseConn, type: "cassandra", port: 9042, database: "probe", localDataCenter: "datacenter1" }],
      ["user"],
    );

    expect(managed.localDataCenter).toBe("datacenter1");
  });

  it("carries a MongoDB connection's auth database through to the managed connection", () => {
    // Dropped here, a seeded connection whose users live in `admin` authenticates
    // against the data database instead and reports a credentials error - the same
    // silent loss, in the mapping that fails no gate.
    const [managed] = filterByRoles(
      [{ ...baseConn, type: "mongodb", port: 27017, database: "shop", authSource: "admin" }],
      ["user"],
    );

    expect(managed.authSource).toBe("admin");
  });
  it("carries a Trino connection's session schema through to the managed connection", () => {
    const [managed] = filterByRoles(
      [{ ...baseConn, type: "trino", port: 8080, database: "memory", schema: "default" }],
      ["user"],
    );

    expect(managed.schema).toBe("default");
  });

  it("carries an Athena connection's region, workgroup and result location through to the managed connection", () => {
    // The region is the whole address: dropped here, a seeded connection is one the
    // provider refuses to construct, and the mapping fails no gate on its own.
    const [managed] = filterByRoles(
      [
        {
          ...baseConn,
          type: "athena",
          database: "analytics",
          region: "us-east-1",
          workgroup: "reporting",
          outputLocation: "s3://lake-results/athena/",
        },
      ],
      ["user"],
    );

    expect(managed.region).toBe("us-east-1");
    expect(managed.workgroup).toBe("reporting");
    expect(managed.outputLocation).toBe("s3://lake-results/athena/");
  });
});

describe("filterByRoles", () => {
  // docs/CONTEXT.md §4.4: a session's group principals open a datasource its role alone
  // would not, and the write rule rides along to where the routes read it.
  it("matches group principals and carries writeRoles through", () => {
    const conns = [
      { ...baseConn, id: "sre-only", roles: ["group:sre"], writeRoles: ["group:dba"] },
      { ...baseConn, id: "everyone", roles: ["*"] },
    ];
    const asSre = filterByRoles(conns, ["*", "user", "group:sre"]);
    expect(asSre.map((c) => c.seedId)).toEqual(["sre-only", "everyone"]);
    expect(asSre[0].writeRoles).toEqual(["group:dba"]);
    expect(asSre[1]).not.toHaveProperty("writeRoles");
    expect(filterByRoles(conns, ["*", "user"]).map((c) => c.seedId)).toEqual(["everyone"]);
  });

  it("includes connections with wildcard role", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["*"] }], ["user"]);
    expect(result).toHaveLength(1);
  });

  it("includes connections matching user role", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["admin"] }], ["admin"]);
    expect(result).toHaveLength(1);
  });

  it("excludes connections not matching user role", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["admin"] }], ["user"]);
    expect(result).toHaveLength(0);
  });

  it("handles multi-role connections", () => {
    const result = filterByRoles([{ ...baseConn, roles: ["admin", "user"] }], ["user"]);
    expect(result).toHaveLength(1);
  });

  it("maps SeedConnection to ManagedConnection correctly", () => {
    const result = filterByRoles(
      [
        {
          ...baseConn,
          id: "my-pg",
          managed: true,
          color: "#FF0000",
          group: "Backend",
        },
      ],
      ["admin"],
    );
    expect(result[0].seedId).toBe("my-pg");
    expect(result[0].id).toBe("seed:my-pg");
    expect(result[0].managed).toBe(true);
    expect(result[0].color).toBe("#FF0000");
    expect(result[0].group).toBe("Backend");
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  it("defaults managed to true when not specified", () => {
    const result = filterByRoles([{ ...baseConn }], ["admin"]);
    expect(result[0].managed).toBe(true);
  });

  it("returns empty array when no connections match", () => {
    const result = filterByRoles(
      [
        { ...baseConn, roles: ["admin"] },
        { ...baseConn, id: "other", roles: ["admin"] },
      ],
      ["user"],
    );
    expect(result).toHaveLength(0);
  });
});

// docs/CONTEXT.md §4.6: the approval rule reaches the routes with the connection, and only when declared.
describe("filterByRoles: write approval", () => {
  it("carries writeApproval and approverRoles through, and adds nothing when absent", () => {
    const [gated, plain] = filterByRoles(
      [
        { ...baseConn, id: "gated", roles: ["*"], writeApproval: true, approverRoles: ["group:dba"] },
        { ...baseConn, id: "plain", roles: ["*"] },
      ],
      ["*", "user"],
    );
    expect(gated.writeApproval).toBe(true);
    expect(gated.approverRoles).toEqual(["group:dba"]);
    expect(plain).not.toHaveProperty("writeApproval");
    expect(plain).not.toHaveProperty("approverRoles");
  });

  // A virtual datasource (§4.44) opens for whoever opens every member; it writes for nobody
  // and carries its members' export rules so the one export gate can ask them.
  it("lists a virtual datasource only to a session that opens every member, read-only, with the members' export rules", () => {
    const orders: SeedConnection = { ...baseConn, id: "orders", roles: ["*"], environment: "staging" };
    const crm: SeedConnection = {
      ...baseConn,
      id: "crm",
      type: "mysql",
      roles: ["group:backend"],
      exportRoles: ["group:backend"],
      environment: "staging",
    };
    const virtual: SeedConnection = {
      id: "orders-crm",
      name: "Orders x CRM",
      type: "virtual",
      members: ["orders", "crm"],
      roles: ["*"],
      environment: "staging",
    };
    const all = [orders, crm, virtual];
    expect(filterByRoles(all, ["*", "user"]).map((c) => c.seedId)).toEqual(["orders"]);
    const listed = filterByRoles(all, ["*", "user", "group:backend"]);
    expect(listed.map((c) => c.seedId)).toEqual(["orders", "crm", "orders-crm"]);
    const managed = listed[2];
    expect(managed.members).toEqual(["orders", "crm"]);
    expect(managed.writeRoles).toEqual([]);
    expect(managed.memberExportRules).toEqual([
      { environment: "staging", exportRoles: undefined },
      { environment: "staging", exportRoles: ["group:backend"] },
    ]);
    // A member that vanished from the declaration closes the virtual rather than opening a hole.
    expect(filterByRoles([orders, virtual], ["*", "user", "group:backend"]).map((c) => c.seedId)).toEqual(["orders"]);
    // Its own roles still apply first.
    expect(
      filterByRoles(
        all.map((c) => (c.id === "orders-crm" ? { ...c, roles: ["admin"] } : c)),
        ["*", "user", "group:backend"],
      ).map((c) => c.seedId),
    ).toEqual(["orders", "crm"]);
  });
});
