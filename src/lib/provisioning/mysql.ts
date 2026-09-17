/**
 * The portal's own account on MySQL (docs/CONTEXT.md §4.54): the inventory and the plan,
 * the same shape the PostgreSQL pair has (`inventory.ts`, `plan.ts`) with MySQL's own
 * rules.
 *
 * MySQL has no ownership: a privilege is granted on a schema by whoever holds it WITH
 * GRANT OPTION, and a schema-level grant (`ON db.*`) covers the tables to come, so there
 * is no `ALTER DEFAULT PRIVILEGES` and no owner to cover. What can block the plan is the
 * bootstrap lacking `CREATE USER`, or holding the privileges it would pass on without the
 * grant option. The inventory reads both from `information_schema`, which shows an
 * account its own privileges whatever else it may see.
 *
 * The account is `'dbportal_<id>'@'%'`: the portal's pods have no fixed address, and the
 * password, not the host, is what identifies them. Cloud SQL for MySQL: the default user
 * and every user created through the console or the API hold every privilege but SUPER
 * and FILE, with the grant option, so the app's own credential is an ordinary bootstrap;
 * `SUPER` is refused there, which is why the kill grant is the dynamic
 * `CONNECTION_ADMIN` and optional.
 */

import { quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { ProvisionError } from "./errors";
import type { InventoryRunner } from "./inventory";
import {
  PASSWORD_MASK,
  type PlannedStatement,
  type ProvisionInventory,
  type ProvisionPlan,
  type ProvisionProfile,
  type ProvisionRequest,
  type SchemaInventory,
  agentRoleNameFor,
  roleNameFor,
} from "./plan";

/** The host part of every account the portal provisions. */
export const ACCOUNT_HOST = "%";

/** The schemas MySQL keeps for itself; never offered. */
const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

/** `'user'@'host'`, the way information_schema spells a grantee, built from CURRENT_USER(). */
const GRANTEE_EXPR =
  "CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')";

/** Who the bootstrap is, on which database, on which server. */
export const MYSQL_WHO_SQL = "SELECT DATABASE() AS db, CURRENT_USER() AS bootstrap, VERSION() AS version";

/** The bootstrap's global privileges, each with whether it may be passed on. */
export const MYSQL_GLOBAL_SQL = `SELECT PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${GRANTEE_EXPR}`;

/** The bootstrap's schema-level privileges, each with whether it may be passed on. */
export const MYSQL_SCHEMA_PRIVILEGES_SQL = `SELECT TABLE_SCHEMA AS name, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${GRANTEE_EXPR}`;

/** Every schema a person may pick. */
export const MYSQL_SCHEMAS_SQL = `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (${SYSTEM_SCHEMAS.map((name) => `'${name}'`).join(", ")}) ORDER BY SCHEMA_NAME`;

/**
 * Which of the portal's accounts already exist, as far as the bootstrap may see: an
 * account lists in USER_PRIVILEGES (with `USAGE` when it holds nothing) for whoever may
 * read the grant tables. A bootstrap that cannot see it gets a `CREATE USER IF NOT
 * EXISTS` that is harmless when it does, followed by the password set either way.
 */
export const MYSQL_ACCOUNTS_SQL =
  "SELECT DISTINCT GRANTEE AS grantee FROM information_schema.USER_PRIVILEGES WHERE GRANTEE IN (?, ?)";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `'name'@'%'` as a grantee string, the spelling information_schema and GRANT share. */
export function accountFor(name: string): string {
  return `${quoteLiteral(name, "mysql")}@${quoteLiteral(ACCOUNT_HOST, "mysql")}`;
}

/** "8.0.36" → 80036, "10.6.4-MariaDB" → 100604; anything else → 0. */
export function parseVersion(version: string): number {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return 0;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] ?? 0);
}

/** The inventory, for the schemas the request named. */
export async function readMysqlInventory(
  runner: InventoryRunner,
  datasourceId: string,
  schemas: readonly string[],
): Promise<ProvisionInventory> {
  const who = (await runner.query(MYSQL_WHO_SQL)).rows[0];
  if (!who) throw new ProvisionError("The database answered nothing about the bootstrap user", 502);
  const version = text(who.version);

  const global = (await runner.query(MYSQL_GLOBAL_SQL)).rows;
  const grantableEverywhere = global.filter((row) => row.grantable === "YES").map((row) => text(row.privilege));
  const canCreateRole = global.some((row) => text(row.privilege) === "CREATE USER");

  const available = (await runner.query(MYSQL_SCHEMAS_SQL)).rows
    .map((row) => text(row.name))
    .filter((name) => name !== "");

  const roleName = roleNameFor(datasourceId, "mysql");
  const agentRoleName = agentRoleNameFor(datasourceId, "mysql");
  const accounts = (await runner.query(MYSQL_ACCOUNTS_SQL, [accountFor(roleName), accountFor(agentRoleName)])).rows.map(
    (row) => text(row.grantee),
  );

  const described: SchemaInventory[] = [];
  if (schemas.length > 0) {
    const perSchema = (await runner.query(MYSQL_SCHEMA_PRIVILEGES_SQL)).rows;
    for (const name of schemas) {
      // A chosen schema the server does not hold is left out, the way the PostgreSQL read
      // leaves it out: the plan reports it missing.
      if (!available.includes(name)) continue;
      const here = perSchema
        .filter((row) => text(row.name) === name && row.grantable === "YES")
        .map((row) => text(row.privilege));
      described.push({ name, owners: [], grantable: [...new Set([...grantableEverywhere, ...here])] });
    }
  }

  return {
    engine: "mysql",
    serverVersion: parseVersion(version),
    ...(version.toLowerCase().includes("mariadb") ? { mariadb: true } : {}),
    database: text(who.db),
    bootstrapUser: text(who.bootstrap),
    canCreateRole,
    availableSchemas: available,
    schemas: described,
    roleExists: accounts.includes(accountFor(roleName)),
    agentRoleExists: accounts.includes(accountFor(agentRoleName)),
  };
}

function rightsFor(profile: ProvisionProfile): readonly string[] {
  return profile === "readwrite" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : ["SELECT"];
}

function accountStatements(
  name: string,
  password: string,
  exists: boolean,
  profile: ProvisionProfile,
  inventory: ProvisionInventory,
  account: PlannedStatement["account"],
): PlannedStatement[] {
  const who = accountFor(name);
  const pw = quoteLiteral(password, "mysql");
  const statements: PlannedStatement[] = [];
  const add = (sql: string, purpose: string, optional = false): void => {
    statements.push({
      sql,
      shown: sql.replaceAll(pw, PASSWORD_MASK),
      purpose,
      account,
      ...(optional ? { optional } : {}),
    });
  };

  if (exists) {
    add(`ALTER USER ${who} IDENTIFIED BY ${pw}`, `Rotate the password of the existing account ${name}`);
  } else {
    add(
      `CREATE USER IF NOT EXISTS ${who} IDENTIFIED BY ${pw}`,
      `Create the account ${name}: a login, no privilege yet`,
    );
    // The bootstrap may be unable to see an account that exists (information_schema shows
    // each account its own grants), and CREATE USER IF NOT EXISTS leaves such an account's
    // password alone; setting it explicitly makes the plan re-runnable either way.
    add(
      `ALTER USER ${who} IDENTIFIED BY ${pw}`,
      `Set the password of ${name}, whether it was just created or existed unseen`,
    );
  }

  const rights = rightsFor(profile).join(", ");
  for (const schema of inventory.schemas) {
    add(
      `GRANT ${rights} ON ${quoteIdentifier(schema.name, "mysql")}.* TO ${who}`,
      `${rights} on every table ${schema.name} holds today and the ones to come`,
    );
  }

  add(`GRANT PROCESS ON *.* TO ${who}`, "See every session in the sessions panel and the InnoDB status", true);
  add(`GRANT SELECT ON performance_schema.* TO ${who}`, "The statistics the monitoring panels are built from", true);
  if (inventory.mariadb) {
    if (inventory.serverVersion >= 100502) {
      add(`GRANT CONNECTION ADMIN ON *.* TO ${who}`, "Stop a statement from the sessions panel (kill)", true);
    }
  } else if (inventory.serverVersion >= 80000) {
    add(`GRANT CONNECTION_ADMIN ON *.* TO ${who}`, "Stop a statement from the sessions panel (kill)", true);
  }
  return statements;
}

/** The plan for one request against one MySQL inventory; pure, like `buildPlan`. */
export function buildMysqlPlan(
  datasourceId: string,
  request: ProvisionRequest,
  inventory: ProvisionInventory,
  secrets: { password: string; agentPassword: string },
): ProvisionPlan {
  const roleName = roleNameFor(datasourceId, "mysql");
  const agentRoleName = agentRoleNameFor(datasourceId, "mysql");
  const blockers: string[] = [];

  if (!inventory.canCreateRole && !(inventory.roleExists && (!request.agent || inventory.agentRoleExists))) {
    blockers.push(
      `The bootstrap user "${inventory.bootstrapUser}" cannot create accounts (no CREATE USER privilege). On Cloud SQL, the default user and every user created through the console or the API have it. Use such a user as the bootstrap, or run GRANT CREATE USER ON *.* TO ${inventory.bootstrapUser} as one.`,
    );
  }
  const missing = request.schemas.filter((name) => !inventory.schemas.some((schema) => schema.name === name));
  for (const name of missing) blockers.push(`The server has no schema "${name}".`);
  for (const schema of inventory.schemas) {
    const lacking = rightsFor(request.profile).filter((right) => !(schema.grantable ?? []).includes(right));
    if (lacking.length === 0) continue;
    blockers.push(
      `The bootstrap "${inventory.bootstrapUser}" cannot grant ${lacking.join(", ")} on "${schema.name}": it holds them without GRANT OPTION, or not at all. Run GRANT ${rightsFor(request.profile).join(", ")} ON ${quoteIdentifier(schema.name, "mysql")}.* TO ${inventory.bootstrapUser} WITH GRANT OPTION as an administrator, or use one as the bootstrap.`,
    );
  }
  if (request.schemas.length === 0) blockers.push("Pick at least one schema for the account to reach.");

  const statements = [
    ...accountStatements(roleName, secrets.password, inventory.roleExists, request.profile, inventory, "portal"),
    ...(request.agent
      ? accountStatements(agentRoleName, secrets.agentPassword, inventory.agentRoleExists, "read", inventory, "agent")
      : []),
  ];
  return { roleName, agentRoleName, statements, blockers };
}
