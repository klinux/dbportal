/**
 * The MySQL pair of the account plan (docs/CONTEXT.md §4.54): the inventory read off
 * information_schema through a hand-built runner, and the statements the plan emits with
 * MySQL's own rules - schema-level grants that cover the tables to come, no owner, the
 * grant option as the wall, and the administrative privileges spelled per server.
 */
import { describe, expect, test } from "bun:test";
import { ProvisionError } from "@/lib/provisioning/errors";
import type { InventoryRunner } from "@/lib/provisioning/inventory";
import {
  ACCOUNT_HOST,
  MYSQL_ACCOUNTS_SQL,
  MYSQL_GLOBAL_SQL,
  MYSQL_SCHEMA_PRIVILEGES_SQL,
  MYSQL_SCHEMAS_SQL,
  MYSQL_WHO_SQL,
  accountFor,
  buildMysqlPlan,
  parseVersion,
  readMysqlInventory,
} from "@/lib/provisioning/mysql";
import { type ProvisionInventory, roleNameFor, agentRoleNameFor } from "@/lib/provisioning/plan";

type Rows = Record<string, unknown>[];
type Answers = Partial<Record<"who" | "global" | "schemas" | "accounts" | "perSchema", Rows>>;

function runner(answers: Answers): InventoryRunner & { asked: [string, unknown[] | undefined][] } {
  const asked: [string, unknown[] | undefined][] = [];
  return {
    asked,
    query: async (sql: string, params?: unknown[]) => {
      asked.push([sql, params]);
      const rows =
        sql === MYSQL_WHO_SQL
          ? (answers.who ?? [{ db: "shop", bootstrap: "app@%", version: "8.0.36" }])
          : sql === MYSQL_GLOBAL_SQL
            ? (answers.global ?? [
                { privilege: "SELECT", grantable: "YES" },
                { privilege: "CREATE USER", grantable: "YES" },
              ])
            : sql === MYSQL_SCHEMAS_SQL
              ? (answers.schemas ?? [{ name: "sales" }, { name: "shop" }])
              : sql === MYSQL_ACCOUNTS_SQL
                ? (answers.accounts ?? [])
                : (answers.perSchema ?? []);
      return { rows, fields: Object.keys(rows[0] ?? {}), rowCount: rows.length, executionTime: 1 };
    },
  };
}

const SECRETS = { password: "PwPortal_0123456789abcdefghijklmn", agentPassword: "PwAgent__0123456789abcdefghijklmn" };

function inventory(overrides: Partial<ProvisionInventory> = {}): ProvisionInventory {
  return {
    engine: "mysql",
    serverVersion: 80036,
    database: "shop",
    bootstrapUser: "app@%",
    canCreateRole: true,
    availableSchemas: ["sales", "shop"],
    schemas: [{ name: "sales", owners: [], grantable: ["SELECT", "INSERT", "UPDATE", "DELETE"] }],
    roleExists: false,
    agentRoleExists: false,
    ...overrides,
  };
}

describe("accountFor and parseVersion", () => {
  test("spell an account the way GRANT and information_schema do, and read a version out of VERSION()", () => {
    expect(ACCOUNT_HOST).toBe("%");
    expect(accountFor("dbportal_shop")).toBe("'dbportal_shop'@'%'");
    expect(parseVersion("8.0.36")).toBe(80036);
    expect(parseVersion("10.6.4-MariaDB-1:10.6.4+maria~focal")).toBe(100604);
    expect(parseVersion("5.7")).toBe(50700);
    expect(parseVersion("unknown")).toBe(0);
  });
});

describe("readMysqlInventory", () => {
  test("reads who the bootstrap is, what it may pass on globally and per schema, and which accounts exist", async () => {
    const run = runner({
      global: [
        { privilege: "SELECT", grantable: "NO" },
        { privilege: "CREATE USER", grantable: "YES" },
      ],
      perSchema: [
        { name: "sales", privilege: "SELECT", grantable: "YES" },
        { name: "sales", privilege: "INSERT", grantable: "NO" },
        { name: "other", privilege: "SELECT", grantable: "YES" },
      ],
      accounts: [{ grantee: "'dbportal_shop_prod'@'%'" }],
    });

    const inventory = await readMysqlInventory(run, "shop-prod", ["sales", "nope"]);

    expect(inventory).toEqual({
      engine: "mysql",
      serverVersion: 80036,
      database: "shop",
      bootstrapUser: "app@%",
      canCreateRole: true,
      grantableEverywhere: ["CREATE USER"],
      availableSchemas: ["sales", "shop"],
      // What is grantable everywhere is grantable here too; what is held without the
      // option is not listed; a chosen schema the server lacks is left out.
      schemas: [{ name: "sales", owners: [], grantable: ["CREATE USER", "SELECT"] }],
      roleExists: true,
      agentRoleExists: false,
    });
    // The account names reach information_schema as parameters, in the grantee spelling.
    expect(run.asked.find(([sql]) => sql === MYSQL_ACCOUNTS_SQL)?.[1]).toEqual([
      "'dbportal_shop_prod'@'%'",
      "'dbportal_shop_prod_agent'@'%'",
    ]);
  });

  test("marks a MariaDB server, and asks about no schema privileges when no schema was chosen", async () => {
    const run = runner({ who: [{ db: null, bootstrap: "root@localhost", version: "10.6.4-MariaDB" }] });

    const inventory = await readMysqlInventory(run, "shop-prod", []);

    expect(inventory.mariadb).toBe(true);
    expect(inventory.serverVersion).toBe(100604);
    expect(inventory.database).toBe("");
    expect(inventory.schemas).toEqual([]);
    expect(run.asked.some(([sql]) => sql === MYSQL_SCHEMA_PRIVILEGES_SQL)).toBe(false);
  });

  test("refuses a server that answers nothing about the bootstrap", async () => {
    const err = await readMysqlInventory(runner({ who: [] }), "shop-prod", []).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(502);
  });
});

describe("buildMysqlPlan", () => {
  test("names the accounts within MySQL's 32 characters", () => {
    const long = "a-very-long-datasource-identifier-indeed";
    expect(roleNameFor(long, "mysql")).toBe("dbportal_a_very_long_datasource_");
    expect(roleNameFor(long, "mysql").length).toBe(32);
    expect(agentRoleNameFor(long, "mysql")).toBe("dbportal_a_very_long_datas_agent");
    expect(agentRoleNameFor(long, "mysql").length).toBeLessThanOrEqual(32);
  });

  // The read profile, spelled out: create-if-absent then the password set either way,
  // one schema-level grant per schema (which covers the tables to come), and the three
  // optional administrative grants, the kill one as MySQL 8 spells it.
  test("plans the read profile on MySQL 8, with the password masked in what is shown", () => {
    const plan = buildMysqlPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory(),
      SECRETS,
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.roleName).toBe("dbportal_shop_prod");
    expect(plan.statements.map((s) => s.sql)).toEqual([
      `CREATE USER IF NOT EXISTS 'dbportal_shop_prod'@'%' IDENTIFIED BY '${SECRETS.password}'`,
      `ALTER USER 'dbportal_shop_prod'@'%' IDENTIFIED BY '${SECRETS.password}'`,
      "GRANT SELECT ON `sales`.* TO 'dbportal_shop_prod'@'%'",
      "GRANT PROCESS ON *.* TO 'dbportal_shop_prod'@'%'",
      "GRANT SELECT ON performance_schema.* TO 'dbportal_shop_prod'@'%'",
      "GRANT CONNECTION_ADMIN ON *.* TO 'dbportal_shop_prod'@'%'",
    ]);
    expect(plan.statements.map((s) => s.shown).slice(0, 2)).toEqual([
      "CREATE USER IF NOT EXISTS 'dbportal_shop_prod'@'%' IDENTIFIED BY '********'",
      "ALTER USER 'dbportal_shop_prod'@'%' IDENTIFIED BY '********'",
    ]);
    expect(plan.statements.map((s) => s.optional ?? false)).toEqual([false, false, false, true, true, true]);
    expect(plan.statements.every((s) => s.account === "portal")).toBe(true);
    expect(JSON.stringify(plan.statements.map((s) => s.shown))).not.toContain(SECRETS.password);
  });

  test("plans read and write as the four DML rights, rotates an existing account, and adds the agent's read-only account", () => {
    const plan = buildMysqlPlan(
      "shop-prod",
      { profile: "readwrite", schemas: ["sales"], agent: true },
      inventory({ roleExists: true, agentRoleExists: false }),
      SECRETS,
    );

    const portal = plan.statements.filter((s) => s.account === "portal").map((s) => s.sql);
    expect(portal[0]).toBe(`ALTER USER 'dbportal_shop_prod'@'%' IDENTIFIED BY '${SECRETS.password}'`);
    expect(portal[1]).toBe("GRANT SELECT, INSERT, UPDATE, DELETE ON `sales`.* TO 'dbportal_shop_prod'@'%'");
    const agent = plan.statements.filter((s) => s.account === "agent").map((s) => s.sql);
    expect(agent[0]).toBe(
      `CREATE USER IF NOT EXISTS 'dbportal_shop_prod_agent'@'%' IDENTIFIED BY '${SECRETS.agentPassword}'`,
    );
    expect(agent[2]).toBe("GRANT SELECT ON `sales`.* TO 'dbportal_shop_prod_agent'@'%'");
  });

  // The kill grant follows the server: MariaDB 10.5.2+ spells it with a space, older
  // MariaDB and MySQL 5.7 have only SUPER, which the plan never grants.
  test("spells the kill grant per server, and leaves it out where only SUPER would do", () => {
    const sqls = (inv: Partial<ProvisionInventory>) =>
      buildMysqlPlan(
        "s",
        { profile: "read", schemas: ["sales"], agent: false },
        inventory(inv),
        SECRETS,
      ).statements.map((s) => s.sql);

    expect(sqls({ mariadb: true, serverVersion: 100604 })).toContain(
      "GRANT CONNECTION ADMIN ON *.* TO 'dbportal_s'@'%'",
    );
    expect(sqls({ mariadb: true, serverVersion: 100400 }).some((s) => s.includes("CONNECTION"))).toBe(false);
    expect(sqls({ serverVersion: 50744 }).some((s) => s.includes("CONNECTION"))).toBe(false);
    const older = buildMysqlPlan(
      "s",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory({ serverVersion: 50744 }),
      SECRETS,
    );
    expect(older.notes).toEqual([
      "Kill from the sessions panel needs SUPER on this server, which the plan never grants; dbportal_s does without it.",
    ]);
  });

  // Measured on Cloud SQL for MySQL 2026-09-18: the default user passes PROCESS on and not
  // CONNECTION_ADMIN. A global grant the inventory says the bootstrap cannot pass on is left
  // out and noted, so the report shows no refusal and the admin knows what the account lacks.
  test("leaves out a global grant the bootstrap cannot pass on, and says what it costs", () => {
    const plan = buildMysqlPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: true },
      inventory({ grantableEverywhere: ["CREATE USER", "SELECT", "PROCESS"] }),
      SECRETS,
    );

    expect(plan.statements.some((s) => s.sql.includes("CONNECTION_ADMIN"))).toBe(false);
    expect(plan.statements.filter((s) => s.sql.startsWith("GRANT PROCESS"))).toHaveLength(2);
    expect(plan.notes).toHaveLength(2);
    expect(plan.notes?.[0]).toContain("CONNECTION_ADMIN is not granted to dbportal_shop_prod");
    expect(plan.notes?.[0]).toContain("GRANT CONNECTION_ADMIN ON *.* TO 'dbportal_shop_prod'@'%'");
    expect(plan.notes?.[1]).toContain("dbportal_shop_prod_agent");

    const noProcess = buildMysqlPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory({ grantableEverywhere: ["CREATE USER", "SELECT"] }),
      SECRETS,
    );
    expect(noProcess.statements.some((s) => s.sql.startsWith("GRANT PROCESS"))).toBe(false);
    expect(noProcess.notes?.[0]).toContain("PROCESS is not granted");
    // An inventory that did not read the global privileges attempts every optional grant.
    expect(
      buildMysqlPlan("s", { profile: "read", schemas: ["sales"], agent: false }, inventory(), SECRETS).notes,
    ).toEqual([]);
  });

  test("blocks on a bootstrap without CREATE USER unless every account exists, on a missing schema, on rights held without the grant option, and on no schema", () => {
    const request = { profile: "readwrite" as const, schemas: ["sales", "nope"], agent: true };

    const blocked = buildMysqlPlan(
      "shop-prod",
      request,
      inventory({ canCreateRole: false, schemas: [{ name: "sales", owners: [], grantable: ["SELECT", "UPDATE"] }] }),
      SECRETS,
    );
    expect(blocked.blockers).toHaveLength(3);
    expect(blocked.blockers[0]).toContain("no CREATE USER privilege");
    expect(blocked.blockers[1]).toBe('The server has no schema "nope".');
    expect(blocked.blockers[2]).toContain('cannot grant INSERT, DELETE on "sales"');
    expect(blocked.blockers[2]).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `sales`.* TO app@% WITH GRANT OPTION",
    );

    const existing = buildMysqlPlan(
      "shop-prod",
      { ...request, schemas: ["sales"] },
      inventory({ canCreateRole: false, roleExists: true, agentRoleExists: true }),
      SECRETS,
    );
    expect(existing.blockers).toEqual([]);

    const oneMissing = buildMysqlPlan(
      "shop-prod",
      { ...request, schemas: ["sales"] },
      inventory({ canCreateRole: false, roleExists: true, agentRoleExists: false }),
      SECRETS,
    );
    expect(oneMissing.blockers).toHaveLength(1);

    const none = buildMysqlPlan(
      "shop-prod",
      { profile: "read", schemas: [], agent: false },
      inventory({ schemas: [] }),
      SECRETS,
    );
    expect(none.blockers).toEqual(["Pick at least one schema for the account to reach."]);

    // A schema described without a grantable list is one nothing may be granted on.
    const undescribed = buildMysqlPlan(
      "shop-prod",
      { profile: "read", schemas: ["sales"], agent: false },
      inventory({ schemas: [{ name: "sales", owners: [] }] }),
      SECRETS,
    );
    expect(undescribed.blockers[0]).toContain('cannot grant SELECT on "sales"');
  });
});
