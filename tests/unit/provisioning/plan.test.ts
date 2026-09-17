/**
 * The account plan is pure, so every statement it emits is pinned here against a
 * hand-built inventory - including the two spellings of each: the one that runs and the
 * one the admin sees, which must never carry the password.
 */
import { describe, expect, test } from "bun:test";
import {
  PASSWORD_MASK,
  type ProvisionInventory,
  agentRoleNameFor,
  buildPlan,
  roleNameFor,
} from "@/lib/provisioning/plan";

const SECRETS = { password: "p'w", agentPassword: "agent-pw" };

function inventory(overrides: Partial<ProvisionInventory> = {}): ProvisionInventory {
  return {
    serverVersion: 150004,
    database: "shop",
    bootstrapUser: "app",
    canCreateRole: true,
    availableSchemas: ["public", "sales"],
    schemas: [{ name: "sales", owners: [{ role: "app", tables: 12, covered: true }] }],
    roleExists: false,
    agentRoleExists: false,
    ...overrides,
  };
}

describe("role names", () => {
  test("derive from the datasource id, lowercased and slugged, under PostgreSQL's 63-byte bound", () => {
    expect(roleNameFor("shop-prod")).toBe("dbportal_shop_prod");
    expect(roleNameFor("Shop.Prod 2")).toBe("dbportal_shop_prod_2");
    expect(roleNameFor("x".repeat(80))).toHaveLength(63);
    expect(agentRoleNameFor("shop-prod")).toBe("dbportal_shop_prod_agent");
    expect(agentRoleNameFor("x".repeat(80))).toHaveLength(63);
    expect(agentRoleNameFor("x".repeat(80)).endsWith("_agent")).toBe(true);
  });
});

describe("buildPlan", () => {
  test("creates a login-only role, grants the read profile on the schema, and binds the future to each owner", () => {
    const plan = buildPlan("shop-prod", { profile: "read", schemas: ["sales"], agent: false }, inventory(), SECRETS);

    expect(plan.blockers).toEqual([]);
    expect(plan.statements.map((s) => s.sql)).toEqual([
      `CREATE ROLE "dbportal_shop_prod" WITH LOGIN PASSWORD 'p''w' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      `GRANT CONNECT ON DATABASE "shop" TO "dbportal_shop_prod"`,
      `GRANT USAGE ON SCHEMA "sales" TO "dbportal_shop_prod"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA "sales" TO "dbportal_shop_prod"`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA "sales" TO "dbportal_shop_prod"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "app" IN SCHEMA "sales" GRANT SELECT ON TABLES TO "dbportal_shop_prod"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "app" IN SCHEMA "sales" GRANT SELECT ON SEQUENCES TO "dbportal_shop_prod"`,
      `GRANT pg_monitor TO "dbportal_shop_prod"`,
      `GRANT pg_signal_backend TO "dbportal_shop_prod"`,
    ]);
    // The two predefined-role grants are the ones the plan may go on without.
    expect(plan.statements.filter((s) => s.optional).map((s) => s.purpose)).toEqual([
      "Read the statistics views the monitoring panels are built from",
      "Stop a statement from the sessions panel (kill)",
    ]);
    expect(plan.statements.every((s) => s.account === "portal")).toBe(true);
  });

  test("the shown spelling masks the password and nothing else", () => {
    const plan = buildPlan("shop-prod", { profile: "read", schemas: ["sales"], agent: false }, inventory(), SECRETS);

    expect(plan.statements[0].shown).toBe(
      `CREATE ROLE "dbportal_shop_prod" WITH LOGIN PASSWORD ${PASSWORD_MASK} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    expect(plan.statements.some((s) => s.shown.includes("p'w") || s.shown.includes("p''w"))).toBe(false);
    expect(plan.statements[1].shown).toBe(plan.statements[1].sql);
  });

  test("the read-and-write profile adds the DML rights and sequence usage, never DDL", () => {
    const plan = buildPlan("shop-prod", { profile: "readwrite", schemas: ["sales"], agent: false }, inventory(), SECRETS);
    const sql = plan.statements.map((s) => s.sql);

    expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "sales" TO "dbportal_shop_prod"`);
    expect(sql).toContain(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "sales" TO "dbportal_shop_prod"`);
    expect(sql.join("\n")).not.toMatch(/CREATE ON SCHEMA|ALL PRIVILEGES|TRUNCATE/);
  });

  test("rotates rather than creates when the role already exists", () => {
    const plan = buildPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory({ roleExists: true, canCreateRole: false }),
      SECRETS,
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.statements[0].sql).toBe(`ALTER ROLE "dbportal_shop_prod" WITH LOGIN PASSWORD 'p''w'`);
    expect(plan.statements[0].shown).toBe(`ALTER ROLE "dbportal_shop_prod" WITH LOGIN PASSWORD ${PASSWORD_MASK}`);
  });

  test("provisions the agent's account as a read profile beside the portal's", () => {
    const plan = buildPlan("shop-prod", { profile: "readwrite", schemas: ["sales"], agent: true }, inventory(), SECRETS);
    const agent = plan.statements.filter((s) => s.account === "agent");

    expect(agent[0].sql).toBe(
      `CREATE ROLE "dbportal_shop_prod_agent" WITH LOGIN PASSWORD 'agent-pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    expect(agent.map((s) => s.sql)).toContain(`GRANT SELECT ON ALL TABLES IN SCHEMA "sales" TO "dbportal_shop_prod_agent"`);
    expect(agent.some((s) => s.sql.includes("INSERT"))).toBe(false);
    expect(plan.agentRoleName).toBe("dbportal_shop_prod_agent");
  });

  test("blocks on a bootstrap that cannot create roles, unless every role it would create exists", () => {
    const blocked = buildPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: true },
      inventory({ canCreateRole: false, roleExists: true, agentRoleExists: false }),
      SECRETS,
    );
    expect(blocked.blockers).toEqual([expect.stringContaining("cannot create roles (no CREATEROLE)")]);
    expect(blocked.blockers[0]).toContain('ALTER ROLE "app" CREATEROLE');

    const rotation = buildPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: true },
      inventory({ canCreateRole: false, roleExists: true, agentRoleExists: true }),
      SECRETS,
    );
    expect(rotation.blockers).toEqual([]);
  });

  test("blocks on a schema the database does not hold, and on no schema at all", () => {
    const missing = buildPlan("shop-prod", { profile: "read", schemas: ["sales", "nope"], agent: false }, inventory(), SECRETS);
    expect(missing.blockers).toEqual(['The database "shop" has no schema "nope".']);

    const none = buildPlan("shop-prod", { profile: "read", schemas: [], agent: false }, inventory({ schemas: [] }), SECRETS);
    expect(none.blockers).toEqual(["Pick at least one schema for the account to reach."]);
  });

  // Ownership is the wall: the remedy differs by server version, because PostgreSQL 16
  // changed what CREATEROLE may grant.
  test("blocks on an owner the bootstrap cannot act as, with the remedy for the server's version", () => {
    const owners = [
      { role: "app", tables: 12, covered: true },
      { role: "migrations", tables: 3, covered: false },
    ];
    const fifteen = buildPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory({ schemas: [{ name: "sales", owners }] }),
      SECRETS,
    );
    expect(fifteen.blockers).toEqual([
      expect.stringContaining('3 table(s) in "sales" are owned by "migrations"'),
    ]);
    expect(fifteen.blockers[0]).toContain('run GRANT "migrations" TO "app" first');
    // The default privileges are bound to the covered owner only.
    expect(fifteen.statements.some((s) => s.sql.includes('FOR ROLE "migrations"'))).toBe(false);

    const sixteen = buildPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory({ serverVersion: 160002, schemas: [{ name: "sales", owners }] }),
      SECRETS,
    );
    expect(sixteen.blockers[0]).toContain("ADMIN OPTION");
  });

  test("a schema with no relation is granted on with no default privilege to bind", () => {
    const plan = buildPlan(
      "shop-prod",
      { profile: "read", schemas: ["empty"], agent: false },
      inventory({ schemas: [{ name: "empty", owners: [] }] }),
      SECRETS,
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.statements.map((s) => s.sql)).toContain(`GRANT USAGE ON SCHEMA "empty" TO "dbportal_shop_prod"`);
    expect(plan.statements.some((s) => s.sql.startsWith("ALTER DEFAULT PRIVILEGES"))).toBe(false);
  });
});
