/**
 * What the bootstrap connection can say about the database before a plan is built
 * (docs/CONTEXT.md §4.54): who the bootstrap is and whether it may create roles, which
 * schemas exist, who owns the tables in the chosen ones and whether the bootstrap can act
 * as each owner, and whether the portal's roles already exist - which turns a CREATE into
 * a rotation.
 *
 * Every read is parameterised; the schema names a person picked reach the catalog as
 * values, never as SQL text.
 */

import type { DatabaseProvider } from "@/lib/db/types";
import { ProvisionError } from "./errors";
import { type ProvisionInventory, type SchemaInventory, agentRoleNameFor, roleNameFor } from "./plan";

/** The part of a provider these reads use. */
export type InventoryRunner = Pick<DatabaseProvider, "query">;

/** The bootstrap's identity and attributes, the database, and the server. */
export const WHO_SQL = [
  "SELECT current_database() AS database, current_user AS bootstrap,",
  "current_setting('server_version_num')::int AS version,",
  "(SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS can_create_role",
].join(" ");

/** Every schema a person may pick: the catalog's own and the temporary ones left out. */
export const SCHEMAS_SQL = [
  "SELECT nspname AS name FROM pg_namespace",
  "WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'",
  "ORDER BY nspname",
].join(" ");

/** Which of the portal's two roles already exist. */
export const ROLES_SQL = "SELECT rolname AS name FROM pg_roles WHERE rolname = ANY($1)";

/**
 * The owners of the relations in the chosen schemas, and whether the bootstrap may act as
 * each. Relations and not only tables: a view, a materialized view, a partitioned or a
 * foreign table are all granted on by `ON ALL TABLES`, so their owner matters the same.
 * A chosen schema holding nothing still answers a row, so it is reported as present.
 */
export const OWNERS_SQL = [
  "SELECT n.nspname AS schema, r.rolname AS owner, count(c.oid)::int AS tables,",
  "pg_has_role(current_user, r.rolname, 'MEMBER') AS covered",
  "FROM pg_namespace n",
  "LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')",
  "LEFT JOIN pg_roles r ON r.oid = c.relowner",
  "WHERE n.nspname = ANY($1)",
  "GROUP BY n.nspname, r.rolname",
  "ORDER BY n.nspname, r.rolname",
].join(" ");

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

/** The inventory, for the schemas the request named. */
export async function readInventory(
  runner: InventoryRunner,
  datasourceId: string,
  schemas: readonly string[],
): Promise<ProvisionInventory> {
  const who = (await runner.query(WHO_SQL)).rows[0];
  if (!who) throw new ProvisionError("The database answered nothing about the bootstrap user", 502);

  const available = (await runner.query(SCHEMAS_SQL)).rows.map((row) => text(row.name)).filter((name) => name !== "");
  const roles = (await runner.query(ROLES_SQL, [[roleNameFor(datasourceId), agentRoleNameFor(datasourceId)]])).rows.map(
    (row) => text(row.name),
  );

  const described = new Map<string, SchemaInventory["owners"][number][]>();
  if (schemas.length > 0) {
    for (const row of (await runner.query(OWNERS_SQL, [[...schemas]])).rows) {
      const schema = text(row.schema);
      const owner = text(row.owner);
      const owners = described.get(schema) ?? [];
      // A schema with no relation answers one row with a null owner: present, nothing to grant on.
      if (owner !== "") owners.push({ role: owner, tables: count(row.tables), covered: row.covered === true });
      described.set(schema, owners);
    }
  }

  return {
    engine: "postgres",
    serverVersion: count(who.version),
    database: text(who.database),
    bootstrapUser: text(who.bootstrap),
    canCreateRole: who.can_create_role === true,
    availableSchemas: available,
    schemas: [...described.entries()].map(([name, owners]) => ({ name, owners })),
    roleExists: roles.includes(roleNameFor(datasourceId)),
    agentRoleExists: roles.includes(agentRoleNameFor(datasourceId)),
  };
}
