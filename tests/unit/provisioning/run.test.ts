/**
 * Provisioning the account, end to end over fakes: the datasource read from the seed
 * index, the bootstrap provider built by the factory, the store the datasource is swapped
 * in, Vault, and the audit trail. What is pinned is the orchestration - which credential
 * opens the database, what runs, where the password goes, what the datasource ends up
 * holding, and what the report says when a statement is refused - and that no password
 * reaches the audit trail or the report.
 *
 * `mock.module` is process-wide in bun; this file runs alone under tests/run-core.sh.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

interface Statement {
  sql: string;
  params?: unknown[];
}

const audit = mock((_event: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));

let declared: Record<string, unknown> | null = null;
mock.module("@/lib/seed", () => ({ getSeedConnectionByIdUnfiltered: async () => declared }));

let vaultConfigured = true;
const writeKvSecret = mock(async (_mount: string, _path: string, _data: Record<string, string>) => {});
class VaultError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
mock.module("@/lib/vault/client", () => ({
  isVaultConfigured: () => vaultConfigured,
  writeKvSecret,
  VaultError,
}));
let vaultResolution: ((conn: Record<string, unknown>) => Record<string, unknown>) | null = null;
const resetVaultCache = mock(() => {});
mock.module("@/lib/vault/credentials", () => ({
  isVaultReference: (v: unknown) => typeof v === "string" && v.startsWith("vault:"),
  parseVaultReference: (v: string) => {
    const [, mount, ...rest] = v.replace("vault:kv:", "kv:").split(/[:/]/);
    return { kind: "kv", mount, path: rest.join("/").split("#")[0], key: v.split("#")[1] };
  },
  resetVaultCache,
  resolveVaultReferences: async (conn: Record<string, unknown>) => {
    if (vaultResolution) return vaultResolution(conn);
    return { ...conn, password: typeof conn.password === "string" && conn.password.startsWith("vault:") ? "from-vault" : conn.password };
  },
}));

let storeRecords: Record<string, unknown>[] = [];
const updateSharedDatasource = mock(async (id: string, input: Record<string, unknown>, actor: string) => ({ ...input, id, updatedBy: actor }));
mock.module("@/lib/datasources/store", () => ({
  listSharedDatasources: async () => storeRecords,
  updateSharedDatasource,
}));

const removeProvider = mock(async (_id: string) => {});
let openedWith: Record<string, unknown> | null = null;
let connectFails = false;
let refuse: (sql: string) => string | null = () => null;
const ran: Statement[] = [];
let disconnected = 0;
const answers = {
  who: [{ database: "shop", bootstrap: "app", version: 150004, can_create_role: true }],
  schemas: [{ name: "public" }, { name: "sales" }],
  roles: [] as Record<string, unknown>[],
  owners: [{ schema: "sales", owner: "app", tables: 4, covered: true }],
};
mock.module("@/lib/db/factory", () => ({
  createDatabaseProvider: async (connection: Record<string, unknown>) => {
    openedWith = connection;
    return {
      connect: async () => {
        if (connectFails) throw new Error("password authentication failed");
      },
      disconnect: async () => {
        disconnected += 1;
      },
      query: async (sql: string, params?: unknown[]) => {
        ran.push({ sql, params });
        const rows = sql.startsWith("SELECT current_database()")
          ? answers.who
          : sql.startsWith("SELECT nspname")
            ? answers.schemas
            : sql.startsWith("SELECT rolname")
              ? answers.roles
              : sql.startsWith("SELECT n.nspname")
                ? answers.owners
                : (() => {
                    const refusal = refuse(sql);
                    if (refusal) throw new Error(refusal);
                    return [];
                  })();
        return { rows, fields: [], rowCount: rows.length, executionTime: 1 };
      },
    };
  },
  removeProvider,
}));

const { ProvisionError } = await import("@/lib/provisioning/errors");
const { generatePassword, inspectAccount, provisionAccount } = await import("@/lib/provisioning/run");

const REQUEST = { profile: "read" as const, schemas: ["sales"], agent: false };
const input = (overrides: Record<string, unknown> = {}) => ({
  datasourceId: "shop-prod",
  request: REQUEST,
  actor: "root@example.test",
  ...overrides,
});

function datasource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "seed:shop-prod",
    seedId: "shop-prod",
    name: "Shop",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "shop",
    user: "app",
    password: "app-secret",
    environment: "staging",
    roles: ["*"],
    managed: true,
    ...overrides,
  };
}

const storeRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "shop-prod",
  name: "Shop",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "shop",
  user: "app",
  password: "app-secret",
  roles: ["*"],
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  createdBy: "root",
  updatedBy: "root",
  ...overrides,
});

beforeEach(() => {
  audit.mockClear();
  writeKvSecret.mockClear();
  updateSharedDatasource.mockClear();
  removeProvider.mockClear();
  resetVaultCache.mockClear();
  declared = datasource();
  storeRecords = [storeRecord()];
  vaultConfigured = true;
  vaultResolution = null;
  openedWith = null;
  connectFails = false;
  refuse = () => null;
  ran.length = 0;
  disconnected = 0;
  answers.roles = [];
});

describe("generatePassword", () => {
  test("is 32 URL-safe characters, fresh each time", () => {
    const one = generatePassword();
    expect(one).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generatePassword()).not.toBe(one);
  });
});

describe("inspectAccount", () => {
  test("opens the database with the datasource's own credential, under an id the cache never sees, and closes it", async () => {
    const report = await inspectAccount(input());

    expect(openedWith).toMatchObject({ user: "app", password: "app-secret", host: "db.internal" });
    expect(String(openedWith?.id)).toMatch(/^provision:seed:shop-prod:\d+$/);
    expect(disconnected).toBe(1);
    expect(report.inventory.bootstrapUser).toBe("app");
    expect(report.plan.blockers).toEqual([]);
    expect(report.destination).toEqual({ kind: "vault", mount: "dbportal", path: "datasources/shop-prod" });
    // Nothing ran but the reads.
    expect(ran.every((s) => s.sql.startsWith("SELECT"))).toBe(true);
    // The shown plan carries a mask and never the placeholder secret.
    expect(report.plan.statements[0].shown).toContain("'********'");
  });

  test("uses a DBA credential typed for this call instead, and drops any connection string", async () => {
    declared = datasource({ connectionString: "postgresql://app:app-secret@db.internal/shop" });

    await inspectAccount(input({ bootstrap: { user: "dba", password: "dba-secret" } }));

    expect(openedWith).toMatchObject({ user: "dba", password: "dba-secret", connectionString: undefined });
  });

  test("resolves a Vault reference on the datasource and writes to that reference's mount", async () => {
    declared = datasource({ password: "vault:kv:apps/shop#password" });

    const report = await inspectAccount(input({ vaultMount: "ignored" }));

    expect(openedWith).toMatchObject({ password: "from-vault" });
    expect(report.destination).toEqual({ kind: "vault", mount: "apps", path: "datasources/shop-prod" });
  });

  test("takes the requested mount when the datasource names none, and refuses a malformed one", async () => {
    expect((await inspectAccount(input({ vaultMount: "kv-team" }))).destination).toMatchObject({ mount: "kv-team" });
    await expect(inspectAccount(input({ vaultMount: "bad mount" }))).rejects.toThrow(ProvisionError);
  });

  test("keeps the password on the record when Vault is not configured, and refuses a seed-file datasource then", async () => {
    vaultConfigured = false;
    expect((await inspectAccount(input())).destination).toEqual({ kind: "store" });

    storeRecords = [];
    const err = await inspectAccount(input()).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("seed file");
  });

  test("a seed-file datasource with Vault gets its password kept and the references reported", async () => {
    storeRecords = [];

    expect((await inspectAccount(input())).destination).toEqual({
      kind: "seed-file",
      mount: "dbportal",
      path: "datasources/shop-prod",
    });
  });

  test("refuses an unknown datasource, a non-PostgreSQL one, and a credential Vault cannot read", async () => {
    declared = null;
    expect((await inspectAccount(input()).catch((e) => e)).statusCode).toBe(404);

    declared = datasource({ type: "mysql" });
    expect((await inspectAccount(input()).catch((e) => e)).statusCode).toBe(403);

    declared = datasource({ password: "vault:kv:apps/shop#password" });
    vaultResolution = () => {
      throw new VaultError("Vault answered 403 for apps/data/shop", 403);
    };
    const err = await inspectAccount(input()).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("could not be read");
  });

  test("lets a failure that is not Vault's through as itself", async () => {
    declared = datasource({ password: "vault:kv:apps/shop#password" });
    vaultResolution = () => {
      throw new TypeError("a bug");
    };

    await expect(inspectAccount(input())).rejects.toBeInstanceOf(TypeError);
  });

  test("reports a bootstrap that cannot open the database as a 502 naming the engine's reason", async () => {
    connectFails = true;

    const err = await inspectAccount(input()).catch((e) => e);

    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("password authentication failed");
  });
});

describe("provisionAccount", () => {
  test("runs the plan, keeps the password in Vault, swaps the datasource to the references, drops its pool, and audits", async () => {
    const report = await provisionAccount(input({ request: { ...REQUEST, agent: true } }));

    expect(report.completed).toBe(true);
    expect(report.roleName).toBe("dbportal_shop_prod");
    expect(report.agentRoleName).toBe("dbportal_shop_prod_agent");
    expect(report.statements.every((s) => s.outcome === "ran")).toBe(true);
    expect(report.references).toBeUndefined();

    const written = writeKvSecret.mock.calls[0] as unknown as [string, string, Record<string, string>];
    expect(written[0]).toBe("dbportal");
    expect(written[1]).toBe("datasources/shop-prod");
    expect(written[2].user).toBe("dbportal_shop_prod");
    expect(written[2].password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(written[2].agent_user).toBe("dbportal_shop_prod_agent");
    // The CREATE ROLE ran with the password Vault received.
    expect(ran.find((s) => s.sql.startsWith("CREATE ROLE"))?.sql).toContain(`PASSWORD '${written[2].password}'`);
    expect(resetVaultCache).toHaveBeenCalledTimes(1);

    const [id, swapped, actor] = updateSharedDatasource.mock.calls[0] as unknown as [string, Record<string, unknown>, string];
    expect(id).toBe("shop-prod");
    expect(actor).toBe("root@example.test");
    expect(swapped).toMatchObject({
      user: "vault:kv:dbportal/datasources/shop-prod#user",
      password: "vault:kv:dbportal/datasources/shop-prod#password",
      agentUser: "vault:kv:dbportal/datasources/shop-prod#agent_user",
      agentPassword: "vault:kv:dbportal/datasources/shop-prod#agent_password",
      connectionString: undefined,
    });
    expect(removeProvider).toHaveBeenCalledWith("seed:shop-prod");

    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0];
    expect(event).toMatchObject({ type: "datasource_account", action: "provision", target: "shop-prod", result: "success" });
    expect(JSON.stringify(event)).not.toContain(written[2].password);
    expect(JSON.stringify(report)).not.toContain(written[2].password);
    expect(disconnected).toBe(1);
  });

  test("keeps the password on the record itself when Vault is not configured", async () => {
    vaultConfigured = false;

    const report = await provisionAccount(input());

    expect(report.destination).toEqual({ kind: "store" });
    expect(writeKvSecret).not.toHaveBeenCalled();
    const swapped = updateSharedDatasource.mock.calls[0][1] as Record<string, unknown>;
    expect(swapped.user).toBe("dbportal_shop_prod");
    expect(swapped.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect("agentUser" in swapped).toBe(false);
  });

  test("reports the references for a seed-file datasource instead of rewriting anything", async () => {
    storeRecords = [];

    const report = await provisionAccount(input());

    expect(report.destination.kind).toBe("seed-file");
    expect(report.references).toEqual({
      user: "vault:kv:dbportal/datasources/shop-prod#user",
      password: "vault:kv:dbportal/datasources/shop-prod#password",
    });
    expect(updateSharedDatasource).not.toHaveBeenCalled();
    expect(writeKvSecret).toHaveBeenCalledTimes(1);
  });

  test("rotates when the role exists, and says so in the audit trail", async () => {
    answers.roles = [{ name: "dbportal_shop_prod" }];

    const report = await provisionAccount(input());

    expect(report.statements[0].shown).toContain("ALTER ROLE");
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "rotate", result: "success" });
  });

  test("refuses to run a plan with blockers, before any statement", async () => {
    answers.owners = [{ schema: "sales", owner: "migrations", tables: 2, covered: false }];

    const err = await provisionAccount(input()).catch((e) => e);

    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("owned by \"migrations\"");
    expect(ran.some((s) => !s.sql.startsWith("SELECT"))).toBe(false);
    expect(writeKvSecret).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    answers.owners = [{ schema: "sales", owner: "app", tables: 4, covered: true }];
  });

  test("stops at the first refusal that is not optional, keeps no password, and reports every outcome", async () => {
    refuse = (sql) => (sql.startsWith("GRANT USAGE ON SCHEMA") ? "permission denied for schema sales" : null);

    const report = await provisionAccount(input());

    expect(report.completed).toBe(false);
    expect(report.statements.map((s) => s.outcome)).toEqual([
      "ran",
      "ran",
      "refused",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(report.statements[2].error).toBe("permission denied for schema sales");
    expect(writeKvSecret).not.toHaveBeenCalled();
    expect(updateSharedDatasource).not.toHaveBeenCalled();
    expect(audit.mock.calls[0][0]).toMatchObject({ result: "failure" });
    expect(String((audit.mock.calls[0][0] as { details: string }).details)).toContain("stopped at");
  });

  test("goes on past a refused optional grant, recording it", async () => {
    refuse = (sql) => (sql.startsWith("GRANT pg_monitor") ? "must have admin option on role pg_monitor" : null);

    const report = await provisionAccount(input());

    expect(report.completed).toBe(true);
    const monitor = report.statements.find((s) => s.shown.startsWith("GRANT pg_monitor"));
    expect(monitor).toMatchObject({ outcome: "refused", error: "must have admin option on role pg_monitor" });
    expect(report.statements.at(-1)?.outcome).toBe("ran");
    expect(writeKvSecret).toHaveBeenCalledTimes(1);
  });

  test("names a Vault refusal after the role was created, so the admin re-runs rather than wonders", async () => {
    writeKvSecret.mockImplementationOnce(async () => {
      throw new VaultError("Vault answered 403 for dbportal/data/datasources/shop-prod", 403);
    });

    const err = await provisionAccount(input()).catch((e) => e);

    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("The account was created but Vault refused the password");
    expect(err.message).toContain("Run the plan again");
    expect(updateSharedDatasource).not.toHaveBeenCalled();
  });

  test("refuses to swap a datasource deleted while its account was provisioned", async () => {
    let listed = 0;
    mock.module("@/lib/datasources/store", () => ({
      listSharedDatasources: async () => (listed++ === 0 ? [storeRecord()] : []),
      updateSharedDatasource,
    }));
    const { provisionAccount: provision } = await import("@/lib/provisioning/run");

    const err = await provision(input()).catch((e) => e);

    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("deleted while");
  });
});
