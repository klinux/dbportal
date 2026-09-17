/**
 * The portal's own database account, as a plan (docs/CONTEXT.md §4.54).
 *
 * Pure: what runs is decided here from the request and from what the inventory read off
 * the database, and nothing here holds a connection. The plan is a list of statements in
 * the order they run, each with the purpose a person reads beside it, and each carrying
 * two spellings: `sql`, which runs, and `shown`, which is what the admin sees before
 * confirming - the same text with every password replaced, because the password is the
 * one thing the plan carries that must never reach a screen, a log or the audit trail.
 *
 * Two profiles and not "what the portal needs": what the portal needs depends on what the
 * datasource is for. *Read* is `USAGE` on the schemas, `SELECT` on their tables and
 * sequences, the same for the tables to come, and `pg_monitor` so the monitoring panels
 * answer. *Read and write* adds `INSERT`, `UPDATE`, `DELETE` and `USAGE` on sequences,
 * never DDL. `pg_signal_backend` is in both, so `kill` works.
 *
 * Ownership is the wall, and the plan says so rather than failing into it. PostgreSQL lets
 * a role grant on an object only as its owner or as a member of the owner, and `ALTER
 * DEFAULT PRIVILEGES` binds to a named owner, so the inventory reports every owner of
 * every table in the chosen schemas and whether the bootstrap covers it; an owner it does
 * not cover is a BLOCKER, named with the one statement that lifts it. On Cloud SQL for
 * PostgreSQL the `postgres` user is not a superuser and is not a member of the app's role,
 * so this is the ordinary case there, and the app's own credential - the owner - is the
 * bootstrap that covers it.
 */

import { quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";

export type ProvisionProfile = "read" | "readwrite";

export interface ProvisionRequest {
  readonly profile: ProvisionProfile;
  /** The schemas the account may reach; empty means the plan has nothing to grant yet. */
  readonly schemas: readonly string[];
  /** Whether a second, read-only account for the agent's execution profile (#328) is provisioned too. */
  readonly agent: boolean;
}

/** One owner of tables in one schema, and whether the bootstrap can grant on its behalf. */
export interface SchemaOwner {
  readonly role: string;
  readonly tables: number;
  /** `pg_has_role(bootstrap, owner, 'MEMBER')`: the bootstrap may act as this owner. */
  readonly covered: boolean;
}

export interface SchemaInventory {
  readonly name: string;
  readonly owners: readonly SchemaOwner[];
}

/** What the bootstrap connection saw, read once before the plan is built. */
export interface ProvisionInventory {
  /** `server_version_num`, so the plan can say which membership rules apply. */
  readonly serverVersion: number;
  readonly database: string;
  readonly bootstrapUser: string;
  /** `rolcreaterole` of the bootstrap: without it no role can be created. */
  readonly canCreateRole: boolean;
  /** Every schema a person may pick, with the system ones already left out. */
  readonly availableSchemas: readonly string[];
  /** The chosen schemas, described. A chosen schema the database does not hold is absent here. */
  readonly schemas: readonly SchemaInventory[];
  readonly roleExists: boolean;
  readonly agentRoleExists: boolean;
}

export interface PlannedStatement {
  /** What runs. Carries the password where the statement takes one. */
  readonly sql: string;
  /** What the admin sees: `sql` with every password masked. */
  readonly shown: string;
  readonly purpose: string;
  /**
   * A statement the plan can go on without. The two predefined-role grants are the case:
   * `pg_monitor` and `pg_signal_backend` need `ADMIN OPTION` on the predefined role from
   * PostgreSQL 16 on, and a bootstrap that lacks it loses the monitoring panels, not the
   * account. A refusal of an optional statement is recorded and the plan continues.
   */
  readonly optional?: boolean;
  /** Which account this statement is for, so a report can group them. */
  readonly account: "portal" | "agent";
}

export interface ProvisionPlan {
  readonly roleName: string;
  readonly agentRoleName: string;
  readonly statements: readonly PlannedStatement[];
  /**
   * Why the plan must not run yet, each a sentence with the remedy. Empty means it may.
   * A blocker is never silently worked around: a grant the bootstrap cannot make would
   * fail halfway and leave an account that reaches half the schema.
   */
  readonly blockers: readonly string[];
}

/** What a shown statement carries where the password stands in `sql`. */
export const PASSWORD_MASK = "'********'";

/** A role name from a datasource id: the id's slug characters, prefixed, and bounded to PostgreSQL's 63 bytes. */
export function roleNameFor(datasourceId: string): string {
  return `dbportal_${datasourceId.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`.slice(0, 63);
}

export function agentRoleNameFor(datasourceId: string): string {
  return `${roleNameFor(datasourceId).slice(0, 63 - "_agent".length)}_agent`;
}

/** The roles beside the bootstrap that own tables in the chosen schemas and that the bootstrap does not cover. */
function uncoveredOwners(inventory: ProvisionInventory): { schema: string; owner: SchemaOwner }[] {
  return inventory.schemas.flatMap((schema) =>
    schema.owners.filter((owner) => !owner.covered).map((owner) => ({ schema: schema.name, owner })),
  );
}

function accountStatements(
  role: string,
  password: string,
  exists: boolean,
  profile: ProvisionProfile,
  inventory: ProvisionInventory,
  account: PlannedStatement["account"],
): PlannedStatement[] {
  const r = quoteIdentifier(role, "postgres");
  const pw = quoteLiteral(password, "postgres");
  const statements: PlannedStatement[] = [];
  const add = (sql: string, purpose: string, optional = false): void => {
    statements.push({ sql, shown: sql.replace(pw, PASSWORD_MASK), purpose, account, ...(optional ? { optional } : {}) });
  };

  if (exists) {
    add(`ALTER ROLE ${r} WITH LOGIN PASSWORD ${pw}`, `Rotate the password of the existing role ${role}`);
  } else {
    add(
      `CREATE ROLE ${r} WITH LOGIN PASSWORD ${pw} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      `Create the role ${role}: login only, no attribute the portal does not need`,
    );
  }
  add(`GRANT CONNECT ON DATABASE ${quoteIdentifier(inventory.database, "postgres")} TO ${r}`, "Let the role open this database");

  const tableRights = profile === "readwrite" ? "SELECT, INSERT, UPDATE, DELETE" : "SELECT";
  const sequenceRights = profile === "readwrite" ? "USAGE, SELECT" : "SELECT";
  for (const schema of inventory.schemas) {
    const s = quoteIdentifier(schema.name, "postgres");
    add(`GRANT USAGE ON SCHEMA ${s} TO ${r}`, `Let the role see the schema ${schema.name}`);
    add(`GRANT ${tableRights} ON ALL TABLES IN SCHEMA ${s} TO ${r}`, `${tableRights} on every table ${schema.name} holds today`);
    add(
      `GRANT ${sequenceRights} ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`,
      `${sequenceRights} on every sequence in ${schema.name}, which a serial column needs`,
    );
    // Future tables: bound to each owner, because PostgreSQL applies default privileges
    // per creating role. Only the covered owners are here; an uncovered one is a blocker.
    for (const owner of schema.owners.filter((candidate) => candidate.covered)) {
      const o = quoteIdentifier(owner.role, "postgres");
      add(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT ${tableRights} ON TABLES TO ${r}`,
        `The same on the tables ${owner.role} creates in ${schema.name} from now on`,
      );
      add(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT ${sequenceRights} ON SEQUENCES TO ${r}`,
        `The same on the sequences ${owner.role} creates in ${schema.name} from now on`,
      );
    }
  }

  add(`GRANT pg_monitor TO ${r}`, "Read the statistics views the monitoring panels are built from", true);
  add(`GRANT pg_signal_backend TO ${r}`, "Stop a statement from the sessions panel (kill)", true);
  return statements;
}

/**
 * The plan for one request against one inventory.
 *
 * `secrets` are the generated passwords, handed in rather than generated here so the plan
 * stays pure and a test can pin the exact SQL. The agent's account is always the read
 * profile: it is the account the agent's read-only execution profile opens.
 */
export function buildPlan(
  datasourceId: string,
  request: ProvisionRequest,
  inventory: ProvisionInventory,
  secrets: { password: string; agentPassword: string },
): ProvisionPlan {
  const roleName = roleNameFor(datasourceId);
  const agentRoleName = agentRoleNameFor(datasourceId);
  const blockers: string[] = [];

  if (!inventory.canCreateRole && !(inventory.roleExists && (!request.agent || inventory.agentRoleExists))) {
    blockers.push(
      `The bootstrap user "${inventory.bootstrapUser}" cannot create roles (no CREATEROLE). On Cloud SQL, a user created through the console or the API has it; one created with CREATE ROLE in SQL does not. Use such a user as the bootstrap, or run ALTER ROLE ${quoteIdentifier(inventory.bootstrapUser, "postgres")} CREATEROLE as one.`,
    );
  }
  const missing = request.schemas.filter((name) => !inventory.schemas.some((schema) => schema.name === name));
  for (const name of missing) blockers.push(`The database "${inventory.database}" has no schema "${name}".`);
  for (const { schema, owner } of uncoveredOwners(inventory)) {
    const remedy =
      inventory.serverVersion >= 160000
        ? `it needs ADMIN OPTION on that role from PostgreSQL 16 on, so run GRANT ${quoteIdentifier(owner.role, "postgres")} TO ${quoteIdentifier(inventory.bootstrapUser, "postgres")} as a role that has it, or use "${owner.role}" itself as the bootstrap`
        : `run GRANT ${quoteIdentifier(owner.role, "postgres")} TO ${quoteIdentifier(inventory.bootstrapUser, "postgres")} first (a CREATEROLE may do that on PostgreSQL 15 and earlier), or use "${owner.role}" itself as the bootstrap`;
    blockers.push(
      `${owner.tables} table(s) in "${schema}" are owned by "${owner.role}", and the bootstrap "${inventory.bootstrapUser}" cannot grant on its behalf: ${remedy}.`,
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
