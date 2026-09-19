import { describe, it, expect } from "bun:test";
import {
  FreezeWindowSchema,
  SeedConnectionSchema,
  SeedConfigSchema,
  SeedDefaultsSchema,
  SshProfileSchema,
  virtualMembersError,
} from "@/lib/seed/types";

describe("SeedConnectionSchema", () => {
  const validConn = {
    id: "test-pg",
    name: "Test PG",
    type: "postgres",
    host: "localhost",
    port: 5432,
    roles: ["admin"],
  };

  // docs/CONTEXT.md §4.56: object rules are patterns with principals, bounded, and never on a
  // virtual datasource (its members carry their own, and a member with any is refused).
  describe("object rules", () => {
    it("accepts a list of pattern-and-principals rules", () => {
      const result = SeedConnectionSchema.safeParse({
        ...validConn,
        objects: [{ match: "apim-*", roles: ["group:apim"] }, { match: "public.orders", roles: ["*"] }],
      });
      expect(result.success).toBe(true);
    });
    it("refuses a pattern with whitespace or a comma, a rule with nobody, and a list past the bound", () => {
      expect(SeedConnectionSchema.safeParse({ ...validConn, objects: [{ match: "a b", roles: ["*"] }] }).success).toBe(false);
      expect(SeedConnectionSchema.safeParse({ ...validConn, objects: [{ match: "a,b", roles: ["*"] }] }).success).toBe(false);
      expect(SeedConnectionSchema.safeParse({ ...validConn, objects: [{ match: "a", roles: [] }] }).success).toBe(false);
      expect(SeedConnectionSchema.safeParse({ ...validConn, objects: [{ match: "a", roles: ["nobody"] }] }).success).toBe(false);
      const many = Array.from({ length: 101 }, (_, i) => ({ match: `t${i}`, roles: ["*"] }));
      expect(SeedConnectionSchema.safeParse({ ...validConn, objects: many }).success).toBe(false);
    });
    it("refuses them on a virtual datasource, and a member that has any", () => {
      const virtual = { id: "v", name: "V", type: "virtual", roles: ["*"], members: ["a", "b"] };
      expect(SeedConnectionSchema.safeParse({ ...virtual, objects: [{ match: "x", roles: ["*"] }] }).success).toBe(false);
      const members = [
        { id: "a", type: "postgres", objects: [{ match: "x", roles: ["*"] }] },
        { id: "b", type: "postgres" },
      ];
      expect(virtualMembersError(virtual, members)).toBe(
        'Virtual datasource "v" cannot include a: it limits which objects each person sees',
      );
      expect(virtualMembersError(virtual, [{ id: "a", type: "postgres", objects: [] }, members[1]])).toBeNull();
    });
  });

  it("accepts a valid connection", () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
  });

  /**
   * The silent half of the round-trip (#765). Unlike the three
   * `Record<keyof DatabaseConnection, ...>` maps, a zod object STRIPS a key it does not
   * declare, so a seed file setting this on an owner holding tens of thousands of objects
   * would validate, lose the field, and scan the catalog anyway with nothing to show for
   * it. Nothing fails at compile time here, so it is pinned at run time.
   */
  it("carries a connection's no-scan choice through validation", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, skipObjectScan: true });
    expect(result.success).toBe(true);
    expect(result.data?.skipObjectScan).toBe(true);
  });

  it("leaves the no-scan choice absent when the seed does not make one", () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
    expect(result.data?.skipObjectScan).toBeUndefined();
  });

  it("rejects invalid id format (uppercase)", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, id: "INVALID" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty roles array", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: [] });
    expect(result.success).toBe(false);
  });

  it("accepts wildcard role", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ["*"] });
    expect(result.success).toBe(true);
  });

  it("rejects unknown roles like data-team", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ["data-team"] });
    expect(result.success).toBe(false);
  });

  it("accepts combined admin and user roles", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ["admin", "user"] });
    expect(result.success).toBe(true);
  });

  it("rejects invalid port range", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, port: 99999 });
    expect(result.success).toBe(false);
  });

  it("accepts valid color hex", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: "#10B981" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid color format", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: "red" });
    expect(result.success).toBe(false);
  });

  it("rejects a database type outside the DatabaseType union", () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, type: "clickhous" });
    expect(result.success).toBe(false);
  });

  it("accepts every valid database type", () => {
    const allTypes = [
      "postgres",
      "mysql",
      "sqlite",
      "mongodb",
      "redis",
      "oracle",
      "mssql",
      "libredb",
      "couchbase",
      "clickhouse",
      "druid",
      "trino",
      "cassandra",
      "athena",
    ];
    for (const type of allTypes) {
      const result = SeedConnectionSchema.safeParse({ ...validConn, type });
      expect(result.success).toBe(true);
    }
  });
});

describe("SeedConfigSchema", () => {
  it("accepts valid config with version 1", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ id: "a", name: "A", type: "postgres", host: "h", roles: ["*"] }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects version 2", () => {
    const result = SeedConfigSchema.safeParse({
      version: "2",
      connections: [{ id: "a", name: "A", type: "postgres", host: "h", roles: ["*"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate connection IDs", () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [
        { id: "dup", name: "A", type: "postgres", host: "h", roles: ["*"] },
        { id: "dup", name: "B", type: "mysql", host: "h", roles: ["*"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty connections array", () => {
    const result = SeedConfigSchema.safeParse({ version: "1", connections: [] });
    expect(result.success).toBe(false);
  });
});

// docs/CONTEXT.md §4.9: a bastion declared once under `sshProfiles`, named by a datasource.
// docs/CONTEXT.md §4.17: a window declared once, with its two instants in order.
describe("SeedConfigSchema: freeze windows", () => {
  const conn = { id: "a", name: "A", type: "postgres", host: "h", roles: ["*"] };
  const window = { id: "release-42", reason: "Deploy", from: "2026-09-20T22:00:00Z", until: "2026-09-21T02:00:00Z" };
  it("accepts a window list and rejects one whose end is not after its start", () => {
    // docs/CONTEXT.md §4.19: named roles, declared once, with members that are never roles.
    const role = { id: "oncall", name: "On-call", members: ["group:sre-oncall", "user:ana@example.test", "admin"] };
    expect(SeedConfigSchema.safeParse({ version: "1", connections: [conn], namedRoles: [role] }).success).toBe(true);
    expect(
      SeedConfigSchema.safeParse({ version: "1", connections: [conn], namedRoles: [role, { ...role, name: "Dup" }] })
        .success,
    ).toBe(false);
    expect(
      SeedConfigSchema.safeParse({ version: "1", connections: [conn], namedRoles: [{ ...role, members: ["role:x"] }] })
        .success,
    ).toBe(false);
    // docs/CONTEXT.md §4.20: runbooks declared once; a placeholder without a parameter is refused.
    const runbook = {
      id: "customer-orders",
      name: "Orders",
      datasource: "orders",
      sql: "SELECT {{id}}",
      params: [{ name: "id", type: "number" }],
    };
    expect(SeedConfigSchema.safeParse({ version: "1", connections: [conn], runbooks: [runbook] }).success).toBe(true);
    expect(
      SeedConfigSchema.safeParse({ version: "1", connections: [conn], runbooks: [runbook, runbook] }).success,
    ).toBe(false);
    expect(
      SeedConfigSchema.safeParse({ version: "1", connections: [conn], runbooks: [{ ...runbook, sql: "SELECT {{x}}" }] })
        .success,
    ).toBe(false);
    const ok = SeedConfigSchema.safeParse({ version: "1", connections: [conn], freezeWindows: [window] });
    expect(ok.success).toBe(true);
    const backwards = SeedConfigSchema.safeParse({
      version: "1",
      connections: [conn],
      freezeWindows: [{ ...window, until: "2026-09-20T21:00:00Z" }],
    });
    expect(backwards.success).toBe(false);
    expect(FreezeWindowSchema.safeParse({ ...window, datasources: ["Bad Id"] }).success).toBe(false);
  });
});

describe("SeedConfigSchema: SSH profiles", () => {
  const conn = { id: "a", name: "A", type: "postgres", host: "h", roles: ["*"], sshProfile: "bastion" };
  const profile = { id: "bastion", name: "Bastion", host: "b.internal", username: "portal", authMethod: "privateKey" };

  it("accepts a profile list and a datasource that names one; the port defaults to 22", () => {
    const result = SeedConfigSchema.safeParse({ version: "1", connections: [conn], sshProfiles: [profile] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sshProfiles?.[0].port).toBe(22);
      expect(result.data.connections[0].sshProfile).toBe("bastion");
    }
  });

  it("rejects two profiles with the same id, an id that is not a slug, and an unknown auth method", () => {
    expect(
      SeedConfigSchema.safeParse({ version: "1", connections: [conn], sshProfiles: [profile, profile] }).success,
    ).toBe(false);
    expect(SshProfileSchema.safeParse({ ...profile, id: "Not A Slug" }).success).toBe(false);
    expect(SshProfileSchema.safeParse({ ...profile, authMethod: "agent" }).success).toBe(false);
  });
});

describe("SeedDefaultsSchema", () => {
  it("accepts valid ssl config with mode require", () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: "require", rejectUnauthorized: true },
    });
    expect(result.success).toBe(true);
  });

  // D26: SSLMode gained `verify-system`, and this zod enum is a VALUE kept in step by hand -
  // a mode missing here is not a compile error, it is a seed file the server rejects for a
  // mode the product supports.
  it("accepts ssl mode verify-system", () => {
    const result = SeedDefaultsSchema.safeParse({ ssl: { mode: "verify-system" } });
    expect(result.success).toBe(true);
  });

  it("rejects ssl mode prefer (not in SSLMode type)", () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: "prefer" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid environment", () => {
    // docs/CONTEXT.md §4.36: an environment is an id, not one of five words; only its shape is refused here.
    const result = SeedDefaultsSchema.safeParse({ environment: "Not Valid" });
    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: MongoDB's authSource", () => {
  // A seeded MongoDB connection whose users live in `admin` is the ordinary
  // deployment. Without this key the descriptor could not say so, and the managed
  // connection reported a credentials error.
  it("accepts a seeded connection that names its auth database", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "shop",
      name: "Shop",
      type: "mongodb",
      host: "mongo.internal",
      port: 27017,
      database: "shop",
      user: "app",
      password: "s3cret",
      authSource: "admin",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it("rejects an auth database that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "shop",
      name: "Shop",
      type: "mongodb",
      host: "mongo.internal",
      authSource: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: Cassandra's localDataCenter", () => {
  // The driver refuses to connect without it, so a seeded Cassandra connection that
  // could not carry it would be a managed connection nobody can open. It is optional
  // in the SCHEMA - every other engine has no use for it - and required by the
  // provider, which is where the refusal belongs.
  it("accepts a seeded connection that names its data centre", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "ring",
      name: "Ring",
      type: "cassandra",
      host: "cassandra.internal",
      port: 9042,
      database: "probe",
      localDataCenter: "datacenter1",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a data centre that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "ring",
      name: "Ring",
      type: "cassandra",
      host: "cassandra.internal",
      localDataCenter: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

describe("SeedConnectionSchema: Trino's schema", () => {
  it("accepts a seeded connection that names its session schema", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "memory",
      name: "Shop",
      type: "trino",
      host: "trino.internal",
      port: 8080,
      database: "memory",
      user: "app",
      schema: "default",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.schema).toBe("default");
  });

  it("rejects a session schema that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "memory",
      name: "Shop",
      type: "trino",
      host: "trino.internal",
      schema: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});

// docs/CONTEXT.md §4.4: a principal may name a group, and a datasource may say who writes.
describe("SeedConnectionSchema: access rules", () => {
  const base = { id: "ro", name: "Read-only", type: "postgres" };
  it("accepts group principals and a writeRoles list, and rejects a malformed rule", () => {
    const parsed = SeedConnectionSchema.parse({ ...base, roles: ["*", "group:sre"], writeRoles: [] });
    expect(parsed.roles).toEqual(["*", "group:sre"]);
    expect(parsed.writeRoles).toEqual([]);
    expect(SeedConnectionSchema.parse({ ...base, roles: ["admin"] }).writeRoles).toBeUndefined();
    expect(SeedConnectionSchema.safeParse({ ...base, roles: ["group:"] }).success).toBe(false);
    // docs/CONTEXT.md §4.19: a named role is one more principal; its id has the datasource id's shape.
    expect(
      SeedConnectionSchema.parse({ ...base, roles: ["role:oncall"], writeRoles: ["role:on-call-2"] }).roles,
    ).toEqual(["role:oncall"]);
    expect(SeedConnectionSchema.safeParse({ ...base, roles: ["role:On Call"] }).success).toBe(false);
    expect(SeedConnectionSchema.safeParse({ ...base, roles: ["role:"] }).success).toBe(false);
    expect(SeedConnectionSchema.safeParse({ ...base, roles: ["*"], writeRoles: ["dba"] }).success).toBe(false);
  });
});

// docs/CONTEXT.md §4.6: a datasource may require approval for writes and name its reviewers.
describe("SeedConnectionSchema: write approval", () => {
  const base = { id: "gated", name: "Gated", type: "postgres", roles: ["*"] };
  it("accepts writeApproval and approverRoles in the access vocabulary, and rejects other shapes", () => {
    const parsed = SeedConnectionSchema.parse({ ...base, writeApproval: true, approverRoles: ["group:dba"] });
    expect(parsed.writeApproval).toBe(true);
    expect(parsed.approverRoles).toEqual(["group:dba"]);
    expect(SeedConnectionSchema.parse(base).writeApproval).toBeUndefined();
    expect(SeedConnectionSchema.safeParse({ ...base, writeApproval: "yes" }).success).toBe(false);
    expect(SeedConnectionSchema.safeParse({ ...base, approverRoles: ["dba"] }).success).toBe(false);
  });

  // docs/CONTEXT.md §4.16: three optional whole numbers, each with a floor and a ceiling.
  it("accepts limits within their bounds and rejects a zero, a fraction, or a stranger", () => {
    const parsed = SeedConnectionSchema.parse({
      ...base,
      limits: { maxRows: 1000, queryTimeoutMs: 30000, maxConcurrent: 2 },
    });
    expect(parsed.limits).toEqual({ maxRows: 1000, queryTimeoutMs: 30000, maxConcurrent: 2 });
    expect(SeedConnectionSchema.parse({ ...base, limits: {} }).limits).toEqual({});
    expect(SeedConnectionSchema.safeParse({ ...base, limits: { maxRows: 0 } }).success).toBe(false);
    expect(SeedConnectionSchema.safeParse({ ...base, limits: { maxConcurrent: 1.5 } }).success).toBe(false);
    expect(SeedConnectionSchema.safeParse({ ...base, limits: { maxConcurrent: 101 } }).success).toBe(false);
    expect(SeedConnectionSchema.safeParse({ ...base, limits: "many" }).success).toBe(false);
  });

  // docs/CONTEXT.md §4.18: a flag, off unless declared.
  // docs/CONTEXT.md §4.28: one or two reviewers, nothing else.
  it("accepts approvalsRequired of 1 or 2 and rejects the rest", () => {
    expect(SeedConnectionSchema.parse({ ...base, approvalsRequired: 2 }).approvalsRequired).toBe(2);
    expect(SeedConnectionSchema.parse({ ...base, approvalsRequired: 1 }).approvalsRequired).toBe(1);
    expect(SeedConnectionSchema.safeParse({ ...base, approvalsRequired: 3 }).success).toBe(false);
  });

  // docs/CONTEXT.md §4.22: the export rule is a principal list like the others.
  it("accepts exportRoles in the principal vocabulary", () => {
    expect(SeedConnectionSchema.parse({ ...base, exportRoles: ["group:analysts", "role:oncall"] }).exportRoles).toEqual(
      ["group:analysts", "role:oncall"],
    );
    expect(SeedConnectionSchema.parse({ ...base, exportRoles: [] }).exportRoles).toEqual([]);
    expect(SeedConnectionSchema.safeParse({ ...base, exportRoles: ["nobody"] }).success).toBe(false);
  });

  it("accepts requireTicket and rejects anything but a boolean", () => {
    expect(SeedConnectionSchema.parse({ ...base, requireTicket: true }).requireTicket).toBe(true);
    expect(SeedConnectionSchema.safeParse({ ...base, requireTicket: "yes" }).success).toBe(false);
  });

  // docs/CONTEXT.md §4.15: on unless declared off.
  it("accepts guardrails: false as the opt-out and nothing else in that field", () => {
    expect(SeedConnectionSchema.parse({ ...base, guardrails: false }).guardrails).toBe(false);
    expect(SeedConnectionSchema.parse(base).guardrails).toBeUndefined();
    expect(SeedConnectionSchema.safeParse({ ...base, guardrails: "off" }).success).toBe(false);
  });

  // A virtual datasource (docs/CONTEXT.md §4.44): members and nothing an engine would need.
  describe("a virtual datasource", () => {
    const virtual = {
      id: "orders-crm",
      name: "Orders x CRM",
      type: "virtual",
      members: ["orders", "crm"],
      roles: ["*"],
    };
    const pg = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      name: id,
      type: "postgres",
      host: "h",
      roles: ["*"],
      ...over,
    });
    const config = (connections: unknown[], defaults?: Record<string, unknown>) =>
      SeedConfigSchema.safeParse({ version: "1", connections, ...(defaults ? { defaults } : {}) });

    it("accepts two to eight distinct members and refuses an address, a credential or a write rule on it", () => {
      expect(SeedConnectionSchema.safeParse(virtual).success).toBe(true);
      expect(SeedConnectionSchema.safeParse({ ...virtual, members: ["orders"] }).success).toBe(false);
      expect(SeedConnectionSchema.safeParse({ ...virtual, members: ["orders", "orders"] }).success).toBe(false);
      expect(SeedConnectionSchema.safeParse({ ...virtual, members: undefined }).success).toBe(false);
      for (const field of ["host", "password", "writeRoles", "sshProfile"]) {
        const value = field === "writeRoles" ? ["admin"] : "x";
        const result = SeedConnectionSchema.safeParse({ ...virtual, [field]: value });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain(field);
      }
      // members belongs to virtual alone.
      expect(SeedConnectionSchema.safeParse(pg("orders", { members: ["a", "b"] })).success).toBe(false);
    });

    it("among the others: every member declared, PostgreSQL or MySQL, of the same environment, not virtual, not through a bastion", () => {
      expect(config([pg("orders"), pg("crm", { type: "mysql" }), virtual]).success).toBe(true);
      const refused = (connections: unknown[], word: string, defaults?: Record<string, unknown>) => {
        const result = config(connections, defaults);
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain(word);
      };
      refused([pg("orders"), virtual], "not declared");
      refused(
        [pg("orders"), pg("crm", { type: "sqlite", host: undefined, database: "x.db" }), virtual],
        "PostgreSQL and MySQL",
      );
      refused([pg("orders", { environment: "production" }), pg("crm"), virtual], "same environment");
      refused([pg("orders"), pg("crm"), { ...virtual, environment: "production" }], "same environment");
      refused([pg("orders"), pg("crm", { sshProfile: "bastion" }), virtual], "SSH profile");
      refused(
        [pg("orders"), pg("crm"), virtual, { ...virtual, id: "nested", members: ["orders-crm", "orders"] }],
        "another virtual",
      );
      // The default environment counts as the members' and the virtual's alike.
      expect(config([pg("orders"), pg("crm"), virtual], { environment: "staging" }).success).toBe(true);
      expect(
        config([pg("orders", { environment: "staging" }), pg("crm"), virtual], { environment: "staging" }).success,
      ).toBe(true);
    });
  });
});

describe("SeedConnectionSchema: Athena's settings", () => {
  // zod strips an unknown key silently, so a field absent from the schema would
  // round-trip as `undefined` with no error anywhere; this is the guard.
  it("accepts a seeded connection that names its region, workgroup and result location", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "lake",
      name: "Lake",
      type: "athena",
      database: "analytics",
      region: "us-east-1",
      workgroup: "reporting",
      outputLocation: "s3://lake-results/athena/",
      roles: ["*"],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.region).toBe("us-east-1");
      expect(result.data.workgroup).toBe("reporting");
      expect(result.data.outputLocation).toBe("s3://lake-results/athena/");
    }
  });

  it("rejects a region that is not a string", () => {
    const result = SeedConnectionSchema.safeParse({
      id: "lake",
      name: "Lake",
      type: "athena",
      region: 1,
      roles: ["*"],
    });

    expect(result.success).toBe(false);
  });
});
