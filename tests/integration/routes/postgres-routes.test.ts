import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

/**
 * The export, runbook and seed routes against a real PostgreSQL (docs/CONTEXT.md §4.34):
 * the route handlers themselves, with a seed file this test writes and two databases it
 * creates - `it_src` filled, `it_stage` empty - so the copy mode (§4.31) has somewhere to
 * sample from and somewhere to land, masked. Skipped without DBPORTAL_IT_PG_URL, so a core
 * run needs no database; CI provides one (the `integration-postgres` job).
 */
const URL_ = process.env.DBPORTAL_IT_PG_URL ?? "";
const session = { role: "admin", username: "it-admin" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));

const DDL = `
CREATE TABLE customers (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL, name text);
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), note text);`;

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

describe.skipIf(!URL_)("routes on a real PostgreSQL", () => {
  let dir: string;
  let routes: {
    plan: (r: Request) => Promise<Response>;
    run: (r: Request) => Promise<Response>;
    status: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    prepare: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    query: (r: Request) => Promise<Response>;
    exportRoute: (r: Request) => Promise<Response>;
  };
  const json = (path: string, body: unknown) =>
    new Request(`http://localhost/api/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    const u = new URL(URL_);
    await admin(async (c) => {
      for (const db of ["it_src", "it_stage"]) {
        await c.query(`DROP DATABASE IF EXISTS ${db}`);
        await c.query(`CREATE DATABASE ${db}`);
      }
    });
    await inDb("it_src", async (c) => {
      await c.query(DDL);
      await c.query(
        "INSERT INTO customers (email, name) SELECT 'person' || g || '@example.test', 'Person ' || g FROM generate_series(1, 10) g",
      );
      await c.query(
        "INSERT INTO orders (customer_id, note) SELECT ((g - 1) % 10) + 1, 'order ' || g FROM generate_series(1, 30) g",
      );
    });
    await inDb("it_stage", (c) => c.query(DDL));
    dir = mkdtempSync(join(tmpdir(), "dbportal-it-"));
    const conn = (id: string, database: string, environment: string, roles: string) =>
      `  - id: "${id}"\n    name: "${id}"\n    type: postgres\n    host: ${u.hostname}\n    port: ${u.port || 5432}\n    database: ${database}\n    user: "${decodeURIComponent(u.username)}"\n    password: "${decodeURIComponent(u.password)}"\n    environment: ${environment}\n    roles: [${roles}]\n`;
    writeFileSync(
      join(dir, "seed.yaml"),
      `version: "1"\nconnections:\n${conn("it-src", "it_src", "production", '"admin"')}${conn("it-stage", "it_stage", "staging", '"*"')}runbooks:\n  - id: "orders-of"\n    name: "Orders of a customer"\n    datasource: "it-stage"\n    sql: "SELECT count(*) AS n FROM orders WHERE customer_id = {{customer}}"\n    params:\n      - name: customer\n        type: number\n`,
    );
    process.env.SEED_CONFIG_PATH = join(dir, "seed.yaml");
    delete process.env.STORAGE_PROVIDER;
    const { resetCache } = await import("@/lib/seed");
    resetCache();
    routes = {
      plan: (await import("@/app/api/admin/seed-data/plan/route")).POST,
      run: (await import("@/app/api/admin/seed-data/run/route")).POST,
      status: (await import("@/app/api/admin/seed-data/[id]/route")).GET,
      prepare: (await import("@/app/api/runbooks/[id]/prepare/route")).POST,
      // The query route types its request as Next's; a Request is what it reads.
      query: (await import("@/app/api/db/query/route")).POST as unknown as (r: Request) => Promise<Response>,
      exportRoute: (await import("@/app/api/db/export/route")).POST,
    };
  });

  afterAll(async () => {
    const { clearProviderCache } = await import("@/lib/db/factory");
    await clearProviderCache();
    await admin(async (c) => {
      for (const db of ["it_src", "it_stage"]) await c.query(`DROP DATABASE IF EXISTS ${db}`);
    });
    delete process.env.SEED_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { clearRateLimitState } = await import("@/lib/api/rate-limit");
    clearRateLimitState();
  });

  async function settled(id: string) {
    for (let i = 0; i < 60; i++) {
      const res = await routes.status(new Request("http://localhost/api/admin/seed-data/x"), params(id));
      const { run } = (await res.json()) as {
        run: { status: string; tables: { name: string; inserted: number; error?: string }[] };
      };
      if (run.status !== "running") return run;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the seed run did not settle");
  }

  test("the plan reads the target's tables in dependency order", async () => {
    const res = await routes.plan(json("admin/seed-data/plan", { datasourceId: "it-stage" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: { name: string; dependsOn: string[] }[] };
    expect(body.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    expect(body.tables[1].dependsOn).toEqual(["customers"]);
  });

  test("a masked sample is copied across with the source's keys, children by ratio, and the sequences moved past it", async () => {
    const res = await routes.run(
      json("admin/seed-data/run", {
        datasourceId: "it-stage",
        mode: "copy",
        sourceDatasourceId: "it-src",
        counts: { customers: 5 },
        ratios: { orders: 2 },
        truncate: true,
      }),
    );
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: { id: string; mode: string; sourceName: string } };
    expect(run.mode).toBe("copy");
    expect(run.sourceName).toBe("it-src");
    const done = await settled(run.id);
    expect(done.tables.map((t) => t.error)).toEqual([undefined, undefined]);
    expect(done.status).toBe("done");
    expect(done.tables.map((t) => [t.name, t.inserted])).toEqual([
      ["customers", 5],
      ["orders", 10],
    ]);
    await inDb("it_stage", async (c) => {
      const customers = await c.query("SELECT id, email FROM customers ORDER BY id");
      expect(customers.rowCount).toBe(5);
      // The keys are the source's own; the e-mails did not cross unmasked.
      for (const row of customers.rows) {
        expect(row.id).toBeGreaterThanOrEqual(1);
        expect(row.email).not.toMatch(/^person\d+@example\.test$/);
      }
      const orders = await c.query("SELECT count(*)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id");
      expect(orders.rows[0].n).toBe(10);
      // The sequence was moved past the copied keys: a fresh row does not collide.
      const fresh = await c.query("INSERT INTO customers (email) VALUES ('fresh@example.test') RETURNING id");
      expect(fresh.rows[0].id).toBeGreaterThan(Math.max(...customers.rows.map((r) => r.id as number)));
    });
  });

  test("generated rows fill the target after emptying it", async () => {
    const res = await routes.run(
      json("admin/seed-data/run", { datasourceId: "it-stage", counts: { customers: 3, orders: 4 }, truncate: true }),
    );
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: { id: string } };
    const done = await settled(run.id);
    expect(done.status).toBe("done");
    await inDb("it_stage", async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM customers")).rows[0].n).toBe(3);
      expect((await c.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(4);
    });
  });

  test("a runbook is prepared for the datasource's engine and runs through the query route", async () => {
    const id = await inDb(
      "it_stage",
      async (c) => (await c.query("SELECT customer_id FROM orders LIMIT 1")).rows[0].customer_id as number,
    );
    const prepared = await routes.prepare(
      json("runbooks/orders-of/prepare", { values: { customer: id } }),
      params("orders-of"),
    );
    expect(prepared.status).toBe(200);
    const bound = (await prepared.json()) as { sql: string; params: unknown[] };
    expect(bound.sql).toBe("SELECT count(*) AS n FROM orders WHERE customer_id = $1");
    expect(bound.params).toEqual([id]);
    const ran = await routes.query(
      json("db/query", { connectionId: "seed:it-stage", sql: bound.sql, params: bound.params, runbook: "orders-of" }),
    );
    expect(ran.status).toBe(200);
    const body = (await ran.json()) as { rows: { n: string | number }[] };
    expect(Number(body.rows[0].n)).toBeGreaterThan(0);
  });

  test("an export is built on the server, bounded and counted", async () => {
    const res = await routes.exportRoute(
      json("db/export", {
        connectionId: "seed:it-stage",
        sql: "SELECT id, email FROM customers ORDER BY id",
        format: "csv",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Rows")).toBe("3");
    expect(res.headers.get("Content-Disposition")).toContain("export.csv");
    const text = await res.text();
    expect(text.replace(/^﻿/, "").trim().split("\n")).toHaveLength(4);
  });
});
