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
const writeKvSecret = mock(async (_mount: string, _path: string, _data: Record<string, unknown>) => {});
let existing: Record<string, unknown> | null = null;
let readRefusal: Error | null = null;
const readKvSecret = mock(async (_mount: string, _path: string) => {
  if (readRefusal) throw readRefusal;
  if (existing === null) throw new VaultError("Vault answered 404", 404);
  return existing;
});
class VaultError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
class SshProfileResolutionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}
let sshProfiles: Record<string, { host: string; port: number; username: string }> = {};
mock.module("@/lib/ssh-profiles/resolve", () => ({
  SshProfileResolutionError,
  applySshProfile: async (conn: Record<string, unknown>) => {
    if (!conn.sshProfile) return conn;
    const profile = sshProfiles[conn.sshProfile as string];
    if (!profile) throw new SshProfileResolutionError(`no profile ${conn.sshProfile}`, 400);
    return { ...conn, sshTunnel: { enabled: true, ...profile, authMethod: "privateKey", privateKey: "k" } };
  },
}));
mock.module("@/lib/vault/client", () => ({
  isVaultConfigured: () => vaultConfigured,
  writeKvSecret,
  readKvSecret,
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
    return {
      ...conn,
      password: typeof conn.password === "string" && conn.password.startsWith("vault:") ? "from-vault" : conn.password,
    };
  },
}));

let storeRecords: Record<string, unknown>[] = [];
const updateSharedDatasource = mock(async (id: string, input: Record<string, unknown>, actor: string) => ({
  ...input,
  id,
  updatedBy: actor,
}));
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
const tunnelled: Record<string, unknown>[] = [];
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
          : sql.startsWith("SELECT DATABASE()")
            ? [{ db: "shop", bootstrap: "app@%", version: "8.0.36" }]
            : sql.includes("information_schema.USER_PRIVILEGES WHERE GRANTEE = CONCAT")
              ? [
                  { privilege: "SELECT", grantable: "YES" },
                  { privilege: "CREATE USER", grantable: "YES" },
                  { privilege: "PROCESS", grantable: "YES" },
                  { privilege: "CONNECTION_ADMIN", grantable: "YES" },
                ]
              : sql.startsWith("SELECT SCHEMA_NAME")
                ? [{ name: "sales" }]
                : sql.includes("USER_PRIVILEGES WHERE GRANTEE IN") || sql.includes("SCHEMA_PRIVILEGES")
                  ? []
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
  // The one-shot tunnel scope (#457), as the factory offers it: pass-through here, the
  // tunnel itself being the factory's concern; the test below pins that it is used.
  withOneShotTunnel: async (
    connection: Record<string, unknown>,
    run: (c: Record<string, unknown>) => Promise<unknown>,
  ) => {
    tunnelled.push(connection);
    return run({ ...connection, host: connection.sshTunnel ? "127.0.0.1" : connection.host });
  },
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
  readKvSecret.mockClear();
  existing = null;
  readRefusal = null;
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
  tunnelled.length = 0;
  disconnected = 0;
  answers.roles = [];
  sshProfiles = {};
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
    // Opened inside the one-shot tunnel scope, so a datasource behind SSH is reached the
    // way its own pool reaches it; the provider is built with what the scope hands back.
    expect(tunnelled).toHaveLength(1);
    expect(tunnelled[0]).toMatchObject({ user: "app" });
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

  test("resolves a Vault reference on the datasource and defaults the destination to that reference's mount", async () => {
    declared = datasource({ password: "vault:kv:apps/shop#password" });

    const report = await inspectAccount(input());

    expect(openedWith).toMatchObject({ password: "from-vault" });
    expect(report.destination).toEqual({ kind: "vault", mount: "apps", path: "datasources/shop-prod" });
  });

  // A deployment lays Vault out its own way (dbportal/prod/<app>, dbportal/stage/<app>):
  // the path the admin names wins over the default, and a location with no path is refused.
  test("writes where the request says, mount and path, and refuses a location without a path", async () => {
    expect((await inspectAccount(input({ vaultPath: "/dbportal/prod/shop/" }))).destination).toEqual({
      kind: "vault",
      mount: "dbportal",
      path: "prod/shop",
    });
    const err = await inspectAccount(input({ vaultPath: "dbportal" })).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(400);
  });

  // The one path that must be refused: where the application's own credential lives under
  // the key the portal would write. Replacing it would be an outage the portal caused.
  test("refuses a path where the datasource's own credential lives under a key the write would set", async () => {
    declared = datasource({ user: "app", password: "vault:kv:dbportal/prod/shop#password" });

    const err = await inspectAccount(input({ vaultPath: "dbportal/prod/shop" })).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("dbportal/prod/shop#password");

    // A different key at the same path is no clash: the secret is shared, the keys are not.
    declared = datasource({ password: "vault:kv:dbportal/prod/shop#app_password" });
    expect((await inspectAccount(input({ vaultPath: "dbportal/prod/shop" }))).destination).toMatchObject({
      path: "prod/shop",
    });

    // The agent's keys count only when the agent's account is asked for.
    declared = datasource({ agentUser: "vault:kv:dbportal/prod/shop#agent_user", agentPassword: "x" });
    expect((await inspectAccount(input({ vaultPath: "dbportal/prod/shop" }))).destination).toMatchObject({
      path: "prod/shop",
    });
    const withAgent = await inspectAccount(
      input({ vaultPath: "dbportal/prod/shop", request: { ...REQUEST, agent: true } }),
    ).catch((e) => e);
    expect(withAgent.statusCode).toBe(409);
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

  // A datasource behind a bastion is opened the way every other open opens it: the SSH
  // profile it names becomes the tunnel the one-shot scope forwards through. Measured on a
  // deployment 2026-09-17: without this the bootstrap hit the raw host and timed out.
  test("builds the tunnel from the datasource's SSH profile before opening, and names a profile it cannot resolve", async () => {
    declared = datasource({ sshProfile: "bastion" });
    sshProfiles = { bastion: { host: "bastion.internal", port: 22, username: "portal" } };

    await inspectAccount(input());

    expect(tunnelled[0]).toMatchObject({ sshTunnel: { enabled: true, host: "bastion.internal", port: 22 } });
    expect(openedWith).toMatchObject({ host: "127.0.0.1" });

    sshProfiles = {};
    const err = await inspectAccount(input()).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("no profile bastion");
  });

  test("refuses an unknown datasource, one of an engine without account management, and a credential Vault cannot read", async () => {
    declared = null;
    expect((await inspectAccount(input()).catch((e) => e)).statusCode).toBe(404);

    declared = datasource({ type: "mongodb" });
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

    const [id, swapped, actor] = updateSharedDatasource.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
    ];
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
    expect(event).toMatchObject({
      type: "datasource_account",
      action: "provision",
      target: "shop-prod",
      result: "success",
    });
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

  // The same run on MySQL: its own inventory reads, its own statements, the same keeping
  // of the password. The account does not exist, so the ALTER USER that sets the password
  // after CREATE USER IF NOT EXISTS is a provision, not a rotation.
  test("provisions on a MySQL datasource through the MySQL plan", async () => {
    declared = datasource({ type: "mysql", port: 3306 });

    const report = await provisionAccount(input());

    expect(report.completed).toBe(true);
    expect(report.roleName).toBe("dbportal_shop_prod");
    expect(report.statements[0].shown).toBe(
      "CREATE USER IF NOT EXISTS 'dbportal_shop_prod'@'%' IDENTIFIED BY '********'",
    );
    expect(report.statements.map((s) => s.outcome)).toEqual(["ran", "ran", "ran", "ran", "ran", "ran"]);
    expect(ran.some(({ sql }) => sql.startsWith("GRANT SELECT ON `sales`.*"))).toBe(true);
    expect(writeKvSecret.mock.calls[0][2]).toMatchObject({ user: "dbportal_shop_prod" });
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "provision", result: "success" });
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
    expect(err.message).toContain('owned by "migrations"');
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

  // A KV v2 write is a whole version: what the secret holds beside the portal's keys is read
  // and written back, and a read the token may not do stops the write rather than overwrite blind.
  test("keeps the other keys a shared secret holds, and refuses to overwrite one it cannot read", async () => {
    existing = { app_user: "app", app_password: "keep-me", password: "old-portal" };

    await provisionAccount(input({ vaultPath: "dbportal/prod/shop" }));

    expect(readKvSecret).toHaveBeenCalledWith("dbportal", "prod/shop");
    const written = writeKvSecret.mock.calls[0][2] as Record<string, unknown>;
    expect(written.app_user).toBe("app");
    expect(written.app_password).toBe("keep-me");
    expect(written.user).toBe("dbportal_shop_prod");
    expect(written.password).not.toBe("old-portal");

    readRefusal = new VaultError("Vault answered 403 for dbportal/data/prod/shop", 403);
    const err = await provisionAccount(input({ vaultPath: "dbportal/prod/shop" })).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("read and write dbportal/data/prod/shop");
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
