/**
 * The inventory reads are pinned against a hand-built runner: which statements run, with
 * which parameters, and how the catalog's rows become the inventory the plan is built on.
 */
import { describe, expect, test } from "bun:test";
import { ProvisionError } from "@/lib/provisioning/errors";
import { type InventoryRunner, OWNERS_SQL, ROLES_SQL, SCHEMAS_SQL, WHO_SQL, readInventory } from "@/lib/provisioning/inventory";

type Rows = Record<string, unknown>[];

function runner(answers: Partial<Record<"who" | "schemas" | "roles" | "owners", Rows>>): InventoryRunner & { asked: [string, unknown[] | undefined][] } {
  const asked: [string, unknown[] | undefined][] = [];
  return {
    asked,
    query: async (sql: string, params?: unknown[]) => {
      asked.push([sql, params]);
      const rows =
        sql === WHO_SQL
          ? (answers.who ?? [{ database: "shop", bootstrap: "app", version: 150004, can_create_role: true }])
          : sql === SCHEMAS_SQL
            ? (answers.schemas ?? [{ name: "public" }, { name: "sales" }])
            : sql === ROLES_SQL
              ? (answers.roles ?? [])
              : (answers.owners ?? []);
      return { rows, fields: Object.keys(rows[0] ?? {}), rowCount: rows.length, executionTime: 1 };
    },
  };
}

describe("readInventory", () => {
  test("reads who the bootstrap is, the schemas, the roles and the owners of the chosen schemas", async () => {
    const run = runner({
      roles: [{ name: "dbportal_shop_prod" }],
      owners: [
        { schema: "sales", owner: "app", tables: 12, covered: true },
        { schema: "sales", owner: "migrations", tables: "3", covered: false },
        { schema: "empty", owner: null, tables: 0, covered: null },
      ],
    });

    const inventory = await readInventory(run, "shop-prod", ["sales", "empty"]);

    expect(inventory).toEqual({
      serverVersion: 150004,
      database: "shop",
      bootstrapUser: "app",
      canCreateRole: true,
      availableSchemas: ["public", "sales"],
      schemas: [
        {
          name: "sales",
          owners: [
            { role: "app", tables: 12, covered: true },
            { role: "migrations", tables: 3, covered: false },
          ],
        },
        { name: "empty", owners: [] },
      ],
      roleExists: true,
      agentRoleExists: false,
    });
    // The names a person picked reach the catalog as parameters, never as SQL text.
    expect(run.asked.find(([sql]) => sql === OWNERS_SQL)?.[1]).toEqual([["sales", "empty"]]);
    expect(run.asked.find(([sql]) => sql === ROLES_SQL)?.[1]).toEqual([["dbportal_shop_prod", "dbportal_shop_prod_agent"]]);
  });

  test("asks about no owners when no schema was chosen", async () => {
    const run = runner({});

    const inventory = await readInventory(run, "shop-prod", []);

    expect(inventory.schemas).toEqual([]);
    expect(run.asked.some(([sql]) => sql === OWNERS_SQL)).toBe(false);
  });

  test("reads a bootstrap without CREATEROLE, an unreadable version, and unnamed rows honestly", async () => {
    const run = runner({
      who: [{ database: "shop", bootstrap: "ro", version: "garbage", can_create_role: false }],
      schemas: [{ name: "" }, { name: 7 }, { name: "sales" }],
      roles: [{ name: 3 }],
    });

    const inventory = await readInventory(run, "shop-prod", []);

    expect(inventory.canCreateRole).toBe(false);
    expect(inventory.serverVersion).toBe(0);
    expect(inventory.availableSchemas).toEqual(["sales"]);
    expect(inventory.roleExists).toBe(false);
  });

  test("refuses a database that answered nothing about the bootstrap", async () => {
    await expect(readInventory(runner({ who: [] }), "shop-prod", [])).rejects.toBeInstanceOf(ProvisionError);
  });
});
