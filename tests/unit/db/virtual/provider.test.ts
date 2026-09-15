import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ManagedConnection } from "@/lib/seed/types";

/**
 * The virtual provider (docs/CONTEXT.md §4.44) over a recorded DuckDB client: the session
 * opened with its ceilings, the two extensions loaded once each, every member attached
 * read-only under an alias that is its id, then the lock; a member that fails to attach
 * closes the session; a statement refused before the engine sees it when it is not a read,
 * carries a DuckDB read-only word, or reaches for a pass-through function; and the attach
 * strings quoted the way each extension reads them.
 */
const runs: string[] = [];
let failOn: string | null = null;
let opened: { bootstrap: readonly string[]; config: Record<string, unknown> }[] = [];
const closed = mock(() => {});
let lastGone: ((why: string) => void) | undefined;
mock.module("@/lib/db/providers/virtual/client", () => ({
  openVirtualClient: async (
    bootstrap: readonly string[],
    config: Record<string, unknown>,
    options?: { onGone?: (why: string) => void },
  ) => {
    opened.push({ bootstrap, config });
    lastGone = options?.onGone;
    // The runner runs the bootstrap first; a statement that fails there is the open failing.
    for (const sql of bootstrap) {
      runs.push(sql);
      if (failOn && sql.includes(failOn)) throw new Error(`refused: ${failOn}`);
    }
    return {
      path: ":memory:",
      readOnly: false,
      pid: 1,
      async run(sql: string, params?: unknown[]) {
        runs.push(sql);
        if (failOn && sql.includes(failOn)) throw new Error(`refused: ${failOn}`);
        // The explorer's two reads (§4.44): the catalogs the session holds, and one catalog's schemas.
        if (sql.includes("duckdb_databases()")) {
          const rows = ["memory", "orders", "crm"].map((database_name) => ({
            database_name,
            is_session_default: database_name === "memory",
          }));
          return { columnNames: ["database_name"], columnTypes: ["VARCHAR"], rows, rowsChanged: 0 };
        }
        if (sql.includes("duckdb_schemas()")) {
          const names = params?.[0] === "crm" ? ["app", "information_schema", "mysql"] : ["main", "public"];
          const rows = names.map((schema_name) => ({ schema_name, is_session_default: false }));
          return { columnNames: ["schema_name"], columnTypes: ["VARCHAR"], rows, rowsChanged: 0 };
        }
        return { columnNames: ["ok"], columnTypes: ["INTEGER"], rows: [{ ok: 1 }], rowsChanged: 0 };
      },
      interrupt() {},
      close: closed,
    };
  },
}));
const { VirtualProvider, assertVirtualStatement, attachString, libpqValue } = await import(
  "@/lib/db/providers/virtual"
);

const member = (over: Partial<ManagedConnection>): ManagedConnection =>
  ({
    id: `seed:${over.seedId}`,
    name: over.seedId,
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "app",
    user: "app",
    password: "s3cret",
    createdAt: new Date(),
    managed: true,
    roles: ["*"],
    ...over,
  }) as ManagedConnection;
const virtual = (members: ManagedConnection[]) =>
  ({
    id: "seed:orders-crm",
    seedId: "orders-crm",
    name: "Orders x CRM",
    type: "virtual",
    createdAt: new Date(),
    managed: true,
    roles: ["*"],
    members: members.map((m) => m.seedId),
    memberConnections: members,
  }) as ManagedConnection;

describe("virtual provider", () => {
  beforeEach(() => {
    runs.length = 0;
    opened = [];
    failOn = null;
    closed.mockClear();
  });

  test("opens in memory with its ceilings, loads each extension once, attaches every member read-only, then locks", async () => {
    const provider = new VirtualProvider(
      virtual([
        member({ seedId: "orders" }),
        member({ seedId: "crm", type: "mysql", port: 3306 }),
        member({ seedId: "billing" }),
      ]),
    );
    await provider.connect();
    expect(opened).toHaveLength(1);
    expect(opened[0].config).toEqual({ memory_limit: "512MB", threads: "4" });
    expect(opened[0].bootstrap).toEqual([
      "LOAD postgres",
      "LOAD mysql",
      `ATTACH 'host=''db.internal'' port=''5432'' dbname=''app'' user=''app'' password=''s3cret''' AS "orders" (TYPE postgres, READ_ONLY)`,
      `ATTACH 'host=db.internal port=3306 database=app user=app password=s3cret' AS "crm" (TYPE mysql, READ_ONLY)`,
      `ATTACH 'host=''db.internal'' port=''5432'' dbname=''app'' user=''app'' password=''s3cret''' AS "billing" (TYPE postgres, READ_ONLY)`,
      "SET enable_external_access = false",
      "SET lock_configuration = true",
    ]);
    expect(provider.isConnected()).toBe(true);
    // Connecting again is a no-op; the session is the one already open.
    await provider.connect();
    expect(opened).toHaveLength(1);
    // The child gone: the provider is no longer connected, and the next connect opens a new session.
    lastGone?.("The virtual session ended with SIGKILL");
    expect(provider.isConnected()).toBe(false);
    await provider.connect();
    expect(opened).toHaveLength(2);
    const capabilities = provider.getCapabilities();
    expect(capabilities.supportsInlineRowEdit).toBe(false);
    expect(capabilities.maintenanceOperations).toEqual([]);
    expect(capabilities.containerLevels?.[0]).toMatchObject({ id: "catalog", label: "Member" });
  });

  test("a member that fails to attach fails the open and leaves the provider disconnected", async () => {
    failOn = 'AS "crm"';
    const provider = new VirtualProvider(virtual([member({ seedId: "orders" }), member({ seedId: "crm" })]));
    await expect(provider.connect()).rejects.toThrow();
    expect(provider.isConnected()).toBe(false);
  });

  test("a read runs; a write, a DuckDB read-only word or a pass-through function is refused before the engine", async () => {
    const provider = new VirtualProvider(virtual([member({ seedId: "orders" }), member({ seedId: "crm" })]));
    await provider.connect();
    runs.length = 0;
    const result = await provider.query("SELECT 1 AS ok");
    expect(result.rows).toEqual([{ ok: 1 }]);
    expect(runs).toEqual(["SELECT 1 AS ok"]);
    for (const [sql, word] of [
      ["INSERT INTO orders.public.t VALUES (1)", "only reads"],
      ["DELETE FROM orders.public.t", "only reads"],
      ["SELECT * FROM read_text('/etc/hostname')", "READ_TEXT"],
      ["SELECT * FROM postgres_query('orders', 'SELECT 1')", "POSTGRES_QUERY"],
      ["SELECT * FROM mysql_query('crm', 'SELECT 1')", "MYSQL_QUERY"],
      ["SELECT 1; SET enable_external_access = true", "SET"],
    ] as const) {
      await expect(provider.query(sql)).rejects.toThrow(word);
    }
    expect(runs).toEqual(["SELECT 1 AS ok"]);
    // A file named as a table (`SELECT * FROM 'x.csv'`) carries no word this list knows: that
    // one the locked engine refuses, which the integration test proves against a real session.
    // The check is its own function, for the route that wants to refuse before enqueueing.
    expect(() => assertVirtualStatement("WITH x AS (SELECT 1) SELECT * FROM x")).not.toThrow();
    expect(() => assertVirtualStatement("EXPLAIN SELECT 1")).not.toThrow();
    expect(() => assertVirtualStatement("ATTACH 'x' AS y")).toThrow();
  });

  // The explorer (§4.44): the members are the catalogs, in declared order, the first one the
  // session default with its home schema marked; a MySQL member shows the database it declares.
  test("lists the members as catalogs, the first as the session default, and a MySQL member's own database alone", async () => {
    const provider = new VirtualProvider(
      virtual([member({ seedId: "orders" }), member({ seedId: "crm", type: "mysql", database: "app" })]),
    );
    await provider.connect();
    expect(await provider.listContainers()).toEqual([
      { path: ["orders"], name: "orders", level: 0, isSessionDefault: true },
      { path: ["crm"], name: "crm", level: 0, isSessionDefault: false },
    ]);
    expect((await provider.listContainers(["orders"])).map((c) => [c.name, c.isSessionDefault])).toEqual([
      ["main", false],
      ["public", true],
    ]);
    expect((await provider.listContainers(["crm"])).map((c) => [c.name, c.isSessionDefault])).toEqual([["app", false]]);
    expect((await provider.listContainers(["orders", "public"])).map((c) => c.isSessionDefault)).toEqual([]);
  });

  test("needs two members of the engines the embedded one attaches", () => {
    expect(() => new VirtualProvider(virtual([member({ seedId: "orders" })]))).toThrow("at least two");
    expect(
      () => new VirtualProvider(virtual([member({ seedId: "orders" }), member({ seedId: "x", type: "sqlite" })])),
    ).toThrow("cannot join a sqlite");
  });

  test("attach strings: libpq quoting for PostgreSQL, bare pairs for MySQL and a refusal for what they cannot carry", () => {
    expect(libpqValue("it's a \\ pass")).toBe("'it\\'s a \\\\ pass'");
    expect(attachString(member({ seedId: "o", password: "p w'd", ssl: { mode: "verify-system" } as never }))).toBe(
      "host='db.internal' port='5432' dbname='app' user='app' password='p w\\'d' sslmode='verify-full'",
    );
    expect(
      attachString(member({ seedId: "o", ssl: { mode: "require" } as never, port: undefined, user: undefined })),
    ).toBe("host='db.internal' dbname='app' password='s3cret' sslmode='require'");
    expect(attachString(member({ seedId: "c", type: "mysql", port: 3306 }))).toBe(
      "host=db.internal port=3306 database=app user=app password=s3cret",
    );
    expect(() => attachString(member({ seedId: "c", type: "mysql", password: "has space" }))).toThrow(
      "MySQL attach cannot carry",
    );
  });
});
