import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Backups (docs/CONTEXT.md §4.14): what pg_dump and pg_restore are asked, with the password
 * in the environment and never an argument; the file names generated and the ones refused;
 * restore refused on production; the audit line each outcome leaves; the upload when a
 * bucket is set. The tools are a mocked child_process over a real temporary directory.
 */
type Cb = (
  error: (Error & { stderr?: string; killed?: boolean }) | null,
  out?: { stdout: string; stderr: string },
) => void;
let calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
let failWith: ((cmd: string) => (Error & { stderr?: string; killed?: boolean }) | null) | null = null;
let versionFails = false;
mock.module("node:child_process", () => ({
  execFile: (cmd: string, args: string[], optsOrCb: Record<string, unknown> | Cb, maybeCb?: Cb) => {
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as Cb;
    const opts = typeof optsOrCb === "function" ? {} : optsOrCb;
    calls.push({ cmd, args, env: opts.env as NodeJS.ProcessEnv | undefined });
    if (args[0] === "--version") {
      cb(versionFails ? new Error("ENOENT") : null, { stdout: "pg_dump (PostgreSQL) 18", stderr: "" });
      return;
    }
    const error = failWith?.(cmd) ?? null;
    if (!error && cmd === "pg_dump") writeFileSync(args[args.indexOf("-f") + 1], "PGDMP");
    cb(error, { stdout: "", stderr: "" });
  },
}));
const tunnel = mock(async (conn: unknown, run: (c: unknown) => Promise<unknown>) => run(conn));
mock.module("@/lib/db/factory", () => ({ withOneShotTunnel: tunnel }));
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit }));
const upload = mock(async (_b: string, object: string) => object);
mock.module("@/lib/backups/gcs", () => ({ uploadToGcs: upload }));
const logError = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { error: logError, warn: () => {}, info: () => {}, debug: () => {} } }));

const { BackupError } = await import("@/lib/backups/errors");
const {
  backupSupported,
  backupsEnabled,
  createBackup,
  listBackups,
  requireSupported,
  resetToolCheck,
  restoreAllowed,
  restoreBackup,
  toolAvailable,
} = await import("@/lib/backups/store");

const connection = {
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  type: "postgres" as const,
  host: "db.internal",
  port: 5432,
  user: "portal",
  password: "hunter2",
  database: "orders",
  environment: "development" as const,
  ssl: { mode: "verify-system" as const },
  roles: ["*"],
  managed: true as const,
  createdAt: new Date(0),
};
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof BackupError ? e.statusCode : -1;
  }
};
let dir = "";

describe("backups store", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dbportal-backups-"));
    process.env.BACKUP_DIR = dir;
    delete process.env.BACKUP_GCS_BUCKET;
    delete process.env.BACKUP_TIMEOUT_MS;
    calls = [];
    failWith = null;
    versionFails = false;
    resetToolCheck();
    audit.mockClear();
    upload.mockClear();
    logError.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.BACKUP_DIR;
  });

  test("a backup runs pg_dump with the address as arguments, the password and SSL mode in the environment, into a generated file, and is audited", async () => {
    const record = await createBackup(connection as never, "root");
    expect(record.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.dump$/);
    expect(record.size).toBe(5);
    expect(record).not.toHaveProperty("object");
    const dump = calls.find((c) => c.cmd === "pg_dump" && c.args[0] === "-Fc")!;
    expect(dump.args).toEqual([
      "-Fc",
      "-h",
      "db.internal",
      "-p",
      "5432",
      "-U",
      "portal",
      "-d",
      "orders",
      "--no-password",
      "-f",
      path.join(dir, "orders", record.name),
    ]);
    expect(dump.args.join(" ")).not.toContain("hunter2");
    expect(dump.env).toMatchObject({ PGPASSWORD: "hunter2", PGSSLMODE: "verify-full" });
    expect(tunnel).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "backup",
        action: "created",
        target: "orders",
        connectionName: "Orders",
        user: "root",
        result: "success",
      }),
    );
    expect((await listBackups("orders")).map((f) => f.name)).toEqual([record.name]);
  });

  test("with a bucket the file is also uploaded under the datasource's prefix; an upload that fails is audited as such and thrown", async () => {
    process.env.BACKUP_GCS_BUCKET = "acme-backups";
    const record = await createBackup(connection as never, "root");
    expect(record.object).toBe(`dbportal/orders/${record.name}`);
    expect(upload).toHaveBeenCalledWith(
      "acme-backups",
      `dbportal/orders/${record.name}`,
      path.join(dir, "orders", record.name),
    );
    expect(audit.mock.calls.map((c) => (c as unknown[])[0]).map((e) => (e as { action: string }).action)).toEqual([
      "created",
      "uploaded",
    ]);
    upload.mockImplementationOnce(async () => {
      throw new BackupError("The bucket answered HTTP 403", 502);
    });
    expect(await status(createBackup(connection as never, "root"))).toBe(502);
    expect((audit.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ action: "uploaded", result: "failure" });
  });

  // A fleet whose databases the cloud backs up switches the feature off; every route then says so.
  test("BACKUPS_ENABLED=false switches backups off: a 404 before the engine is even looked at", async () => {
    const saved = process.env.BACKUPS_ENABLED;
    try {
      expect(backupsEnabled()).toBe(true);
      process.env.BACKUPS_ENABLED = "yes";
      expect(backupsEnabled()).toBe(true);
      process.env.BACKUPS_ENABLED = "false";
      expect(backupsEnabled()).toBe(false);
      const off = (() => {
        try {
          requireSupported(connection as never);
          return null;
        } catch (e) {
          return e as InstanceType<typeof BackupError>;
        }
      })();
      expect(off?.statusCode).toBe(404);
      expect(off?.message).toContain("switched off");
      expect(await status(createBackup(connection as never, "root"))).toBe(404);
    } finally {
      if (saved === undefined) delete process.env.BACKUPS_ENABLED;
      else process.env.BACKUPS_ENABLED = saved;
    }
  });

  test("an engine without a tool, a missing pg_dump, and a tool that fails or times out are refused with the right status; stderr stays in the log", async () => {
    expect(backupSupported("mysql")).toBe(false);
    expect(await status(createBackup({ ...connection, type: "mysql" } as never, "root"))).toBe(400);
    versionFails = true;
    expect(await toolAvailable()).toBe(false);
    expect(await status(createBackup(connection as never, "root"))).toBe(503);
    resetToolCheck();
    versionFails = false;
    failWith = () =>
      Object.assign(new Error("exit 1"), {
        stderr: "pg_dump: error: connection to server failed: FATAL: password authentication failed",
      });
    const failed = await createBackup(connection as never, "root").catch((e) => e);
    expect(failed).toBeInstanceOf(BackupError);
    expect(failed.statusCode).toBe(502);
    expect(failed.message).not.toContain("FATAL");
    expect(JSON.stringify(logError.mock.calls[0])).toContain("password authentication failed");
    expect((audit.mock.calls.at(-1) as unknown[])[0]).toMatchObject({
      action: "created",
      result: "failure",
      reason: "execution_failed",
    });
    failWith = () => Object.assign(new Error("killed"), { killed: true });
    const timedOut = await createBackup(connection as never, "root").catch((e) => e);
    expect(timedOut.message).toBe("Backup timed out");
  });

  test("a restore runs pg_restore --clean over the datasource's own file and is audited; production is refused before anything runs", async () => {
    const record = await createBackup(connection as never, "root");
    calls = [];
    const restored = await restoreBackup(connection as never, record.name, "root");
    expect(restored.name).toBe(record.name);
    const call = calls.find((c) => c.cmd === "pg_restore")!;
    expect(call.args.slice(0, 3)).toEqual(["--clean", "--if-exists", "--no-owner"]);
    expect(call.args.at(-1)).toBe(path.join(dir, "orders", record.name));
    expect(call.env).toMatchObject({ PGPASSWORD: "hunter2" });
    expect((audit.mock.calls.at(-1) as unknown[])[0]).toMatchObject({
      type: "backup",
      action: "restored",
      result: "success",
    });

    expect(restoreAllowed({ environment: "production" })).toBe(false);
    calls = [];
    expect(
      await status(restoreBackup({ ...connection, environment: "production" } as never, record.name, "root")),
    ).toBe(403);
    expect(calls).toEqual([]);
  });

  test("a restore refuses a malformed name, a file that is not there, a missing tool, and reports a failed run", async () => {
    expect(await status(restoreBackup(connection as never, "../../etc/passwd", "root"))).toBe(400);
    expect(await status(restoreBackup(connection as never, "2026-01-01T00-00-00Z.dump", "root"))).toBe(404);
    mkdirSync(path.join(dir, "orders"), { recursive: true });
    writeFileSync(path.join(dir, "orders", "2026-01-01T00-00-00Z.dump"), "PGDMP");
    versionFails = true;
    expect(await status(restoreBackup(connection as never, "2026-01-01T00-00-00Z.dump", "root"))).toBe(503);
    resetToolCheck();
    versionFails = false;
    failWith = (cmd) =>
      cmd === "pg_restore" ? Object.assign(new Error("exit 1"), { stderr: "pg_restore: error" }) : null;
    expect(await status(restoreBackup(connection as never, "2026-01-01T00-00-00Z.dump", "root"))).toBe(502);
    expect((audit.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ action: "restored", result: "failure" });
  });

  test("listBackups answers newest first, ignores foreign files, an absent directory and a malformed id", async () => {
    mkdirSync(path.join(dir, "orders"), { recursive: true });
    for (const name of ["2026-01-01T00-00-00Z.dump", "2026-03-01T00-00-00Z.dump", "notes.txt"]) {
      writeFileSync(path.join(dir, "orders", name), "x");
    }
    expect((await listBackups("orders")).map((f) => f.name)).toEqual([
      "2026-03-01T00-00-00Z.dump",
      "2026-01-01T00-00-00Z.dump",
    ]);
    expect(await listBackups("nothing-here")).toEqual([]);
    expect(await status(listBackups("../etc"))).toBe(400);
  });

  test("a connection without an address or credential passes nothing for them; a failed audit sink is logged, not thrown", async () => {
    const bare = {
      ...connection,
      host: undefined,
      port: undefined,
      user: undefined,
      password: undefined,
      database: undefined,
      ssl: undefined,
    };
    audit.mockImplementationOnce(() => {
      throw new Error("sink");
    });
    const record = await createBackup(bare as never, "root");
    const dump = calls.find((c) => c.cmd === "pg_dump" && c.args[0] === "-Fc")!;
    expect(dump.args).toEqual(["-Fc", "--no-password", "-f", path.join(dir, "orders", record.name)]);
    expect(dump.env).not.toHaveProperty("PGPASSWORD");
    expect(logError).toHaveBeenCalled();
  });

  test("the timeout comes from BACKUP_TIMEOUT_MS when it is a positive whole number", async () => {
    process.env.BACKUP_TIMEOUT_MS = "5000";
    await createBackup(connection as never, "root");
    const first = calls.find((c) => c.cmd === "pg_dump" && c.args[0] === "-Fc");
    expect(first).toBeDefined();
  });
});
