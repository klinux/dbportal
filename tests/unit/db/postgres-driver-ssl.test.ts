import { describe, expect, test } from "bun:test";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";

/**
 * The datasource driver's pool config for a connection string (docs/CONTEXT.md §4.47): the
 * URL reaches `pg` without its sslmode, and the mode decides the explicit `ssl` - as libpq
 * reads it - unless the form's own SSL block says otherwise. The driver's parser is asked
 * what it would use, so the driver and this reading cannot disagree.
 */
type Config = { connectionString?: string; ssl?: unknown; host?: string };
const poolConfig = (provider: PostgresProvider): Config =>
  (provider as unknown as { buildPoolConfig: () => Config }).buildPoolConfig();
const base = { id: "x", name: "X", type: "postgres" as const, createdAt: new Date() };

describe("postgres driver: a connection string's sslmode", () => {
  test("the sslmode is read off the URL, the URL handed over without it, and the driver agrees", async () => {
    const { default: ConnectionParameters } = await import("pg/lib/connection-parameters");
    const cases: [string, false | { rejectUnauthorized: boolean } | undefined][] = [
      ["postgresql://u:p@10.0.0.5:5432/db?sslmode=require", { rejectUnauthorized: false }],
      ["postgresql://u:p@10.0.0.5:5432/db?sslmode=verify-full", { rejectUnauthorized: true }],
      ["postgresql://u:p@10.0.0.5:5432/db?sslmode=disable", false],
      // No mode, no cloud host, no form block: the driver's own default, which is plain.
      ["postgresql://u:p@10.0.0.5:5432/db", undefined],
    ];
    for (const [url, ssl] of cases) {
      const cfg = poolConfig(new PostgresProvider({ ...base, connectionString: url }));
      expect(cfg.connectionString).not.toContain("sslmode");
      expect(cfg.ssl).toEqual(ssl);
      const driver = new ConnectionParameters(cfg as never).ssl;
      expect(driver).toEqual(ssl === undefined ? false : ssl);
    }
  });

  test("the form's own SSL block still wins over the URL", () => {
    const cfg = poolConfig(
      new PostgresProvider({
        ...base,
        connectionString: "postgresql://u:p@10.0.0.5:5432/db?sslmode=disable",
        ssl: { mode: "verify-full", caCert: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" },
      }),
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true, ca: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" });
    // Host and port config keeps its cloud auto-detection untouched.
    const rds = poolConfig(new PostgresProvider({ ...base, host: "db.abc.us-east-1.rds.amazonaws.com", database: "d" }));
    expect(rds.ssl).toEqual({ rejectUnauthorized: false });
    expect(rds.connectionString).toBeUndefined();
  });
});
