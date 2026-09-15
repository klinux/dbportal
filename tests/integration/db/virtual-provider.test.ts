import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "pg";
import type { ManagedConnection } from "@/lib/seed/types";

/**
 * A virtual datasource on real engines (docs/CONTEXT.md §4.44): two PostgreSQL databases
 * attached as members of one DuckDB session, a join across them with the filter pushed
 * down, the lock holding against the SQL a person could write, and the members' catalogs
 * listed under their ids. Skipped without DBPORTAL_IT_PG_URL; CI provides one.
 */
const URL_ = process.env.DBPORTAL_IT_PG_URL ?? "";

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: URL_ });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
async function inDb<T>(db: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const u = new URL(URL_);
  u.pathname = `/${db}`;
  const client = new Client({ connectionString: u.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
function memberOf(id: string, db: string): ManagedConnection {
  const u = new URL(URL_);
  return {
    id: `seed:${id}`,
    seedId: id,
    name: id,
    type: "postgres",
    host: u.hostname,
    port: Number(u.port || 5432),
    database: db,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    createdAt: new Date(),
    managed: true,
    roles: ["*"],
  } as ManagedConnection;
}

describe.skipIf(!URL_)("a virtual datasource on PostgreSQL members", () => {
  let provider: InstanceType<typeof import("@/lib/db/providers/virtual").VirtualProvider>;

  beforeAll(async () => {
    await admin(async (c) => {
      for (const db of ["it_v_orders", "it_v_crm"]) {
        await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${db}`);
      }
    });
    await inDb("it_v_orders", async (c) => {
      await c.query("CREATE TABLE pedidos (id int PRIMARY KEY, cliente_id int NOT NULL, total numeric(12,2) NOT NULL)");
      await c.query("INSERT INTO pedidos SELECT g, 1 + (g % 3), g * 10 FROM generate_series(1, 30) g");
    });
    await inDb("it_v_crm", async (c) => {
      await c.query("CREATE TABLE clientes (id int PRIMARY KEY, nome text NOT NULL)");
      await c.query("INSERT INTO clientes VALUES (1, 'Ana'), (2, 'Bia'), (3, 'Caio')");
    });
    const { VirtualProvider } = await import("@/lib/db/providers/virtual");
    provider = new VirtualProvider({
      id: "seed:orders-crm",
      seedId: "orders-crm",
      name: "Orders x CRM",
      type: "virtual",
      createdAt: new Date(),
      managed: true,
      roles: ["*"],
      members: ["orders", "crm"],
      memberConnections: [memberOf("orders", "it_v_orders"), memberOf("crm", "it_v_crm")],
    } as ManagedConnection);
    await provider.connect();
  });

  afterAll(async () => {
    await provider?.disconnect();
    await admin(async (c) => {
      for (const db of ["it_v_orders", "it_v_crm"]) await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    });
  });

  test("joins the members under their ids, and the members' filters are pushed down", async () => {
    const result = await provider.query(
      "SELECT c.nome, count(*) AS pedidos, sum(p.total) AS total FROM orders.public.pedidos p JOIN crm.public.clientes c ON c.id = p.cliente_id WHERE p.total > 100 GROUP BY c.nome ORDER BY c.nome",
    );
    // total > 100 leaves g = 11..30; cliente_id = 1 + g % 3.
    expect(result.rows.map((r) => [r.nome, Number(r.pedidos)])).toEqual([
      ["Ana", 7],
      ["Bia", 6],
      ["Caio", 7],
    ]);
    const plan = await provider.query(
      "EXPLAIN SELECT p.id FROM orders.public.pedidos p JOIN crm.public.clientes c ON c.id = p.cliente_id WHERE c.id = 2",
    );
    expect(JSON.stringify(plan.rows)).toContain("POSTGRES_SCAN");
    expect(JSON.stringify(plan.rows)).toMatch(/Filters[\s\S]*id=2/);
  });

  test("the lock holds: nothing the person writes attaches, reads a file, changes a setting or writes a member", async () => {
    // Through the provider, the word list answers first; the engine's own refusal is proved
    // by running the same through the locked client the provider holds.
    const client = (provider as unknown as { client: { run(sql: string): Promise<unknown> } }).client;
    for (const sql of [
      "ATTACH 'x.db' AS y",
      "INSTALL httpfs",
      "LOAD httpfs",
      "SELECT * FROM read_text('/etc/hostname')",
      "SET enable_external_access = true",
      "SET memory_limit = '64GB'",
      "INSERT INTO crm.public.clientes VALUES (9, 'x')",
    ]) {
      await expect(client.run(sql)).rejects.toThrow();
      await expect(provider.query(sql)).rejects.toThrow();
    }
  });

  test("the members are the catalogs the explorer lists, with their schemas and tables", async () => {
    const containers = await provider.listContainers();
    expect(containers.map((c) => [c.name, c.isSessionDefault])).toEqual([
      ["orders", true],
      ["crm", false],
    ]);
    const schemas = await provider.listContainers(["orders"]);
    expect(schemas.find((s) => s.name === "public")?.isSessionDefault).toBe(true);
    expect((await provider.listContainers(["crm"])).find((s) => s.name === "public")?.isSessionDefault).toBe(false);
    const tables = await provider.listObjects(["crm", "public"], "table");
    expect(tables.map((t) => t.name)).toEqual(["clientes"]);
  });
});
