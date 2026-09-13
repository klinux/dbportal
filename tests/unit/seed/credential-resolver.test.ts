import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  resolveConnectionCredentials,
  resolveAllCredentials,
  resolveEnvPlaceholders,
  resetPlaintextWarnings,
} from "@/lib/seed/credential-resolver";
import type { DatabaseConnection } from "@/lib/types";
import type { SeedConnection } from "@/lib/seed/types";

const baseConn: SeedConnection = {
  id: "test",
  name: "Test",
  type: "postgres",
  host: "localhost",
  roles: ["*"],
};

describe("credential-resolver", () => {
  beforeEach(() => {
    resetPlaintextWarnings();
  });

  afterEach(() => {
    delete process.env.MY_PASSWORD;
    delete process.env.MY_HOST;
    delete process.env.MY_USER;
    delete process.env.MY_DB;
    delete process.env.MY_CONN_STR;
  });

  it("resolves ${VAR} in password field", () => {
    process.env.MY_PASSWORD = "secret123";
    const conn = { ...baseConn, password: "${MY_PASSWORD}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe("secret123");
  });

  it("resolves ${VAR} in connectionString field", () => {
    process.env.MY_CONN_STR = "mongodb://user:pass@host/db";
    const conn = { ...baseConn, connectionString: "${MY_CONN_STR}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.connectionString).toBe("mongodb://user:pass@host/db");
  });

  it("resolves ${VAR} in user, host, database fields", () => {
    process.env.MY_USER = "admin";
    process.env.MY_HOST = "db.internal";
    process.env.MY_DB = "mydb";
    const conn = { ...baseConn, user: "${MY_USER}", host: "${MY_HOST}", database: "${MY_DB}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.user).toBe("admin");
    expect(resolved.host).toBe("db.internal");
    expect(resolved.database).toBe("mydb");
  });

  it("throws when env var is not defined", () => {
    const conn = { ...baseConn, password: "${NONEXISTENT_VAR}" };
    expect(() => resolveConnectionCredentials(conn)).toThrow(/NONEXISTENT_VAR/);
  });

  it("leaves fields without ${} pattern unchanged", () => {
    const conn = { ...baseConn, host: "static-host.internal", port: 5432 };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.host).toBe("static-host.internal");
    expect(resolved.port).toBe(5432);
  });

  it("resolveAllCredentials skips connections with unresolvable vars", () => {
    process.env.MY_PASSWORD = "good";
    const connections: SeedConnection[] = [
      { ...baseConn, id: "good", password: "${MY_PASSWORD}" },
      { ...baseConn, id: "bad", password: "${MISSING}" },
      { ...baseConn, id: "also-good", host: "static" },
    ];
    const resolved = resolveAllCredentials(connections);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].id).toBe("good");
    expect(resolved[1].id).toBe("also-good");
  });

  // docs/CONTEXT.md §4.5: a `vault:` reference is resolved later, per person; it passes the
  // seed loader untouched and is not a plaintext password to warn about.
  it("leaves a vault: reference untouched, without a plaintext warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const conn = { ...baseConn, id: "vaulted", password: "vault:db:database/orders" };
      expect(resolveConnectionCredentials(conn).password).toBe("vault:db:database/orders");
      expect(resolveAllCredentials([conn])).toHaveLength(1);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("plaintext"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not throw for plaintext passwords, just warns", () => {
    const conn = { ...baseConn, id: "plain", password: "hardcoded_secret" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe("hardcoded_secret");
  });

  // docs/CONTEXT.md §4.1 step B: an admin types `${VAR}` into the browser form the way a seed
  // file would, so the datasource is tested with the credential the server holds and saved
  // with the reference. A literal value passes through untouched and earns no plaintext
  // warning - a browser connection is expected to carry its value.
  describe("resolveEnvPlaceholders", () => {
    const browserConn: DatabaseConnection = {
      id: "b1",
      name: "Browser",
      type: "postgres",
      host: "${MY_HOST}",
      password: "${MY_PASSWORD}",
      user: "app",
      createdAt: new Date(0),
    };

    it("resolves every ${VAR} credential field and leaves literals alone", () => {
      process.env.MY_PASSWORD = "from-env";
      process.env.MY_HOST = "db.internal";
      const resolved = resolveEnvPlaceholders(browserConn);
      expect(resolved.password).toBe("from-env");
      expect(resolved.host).toBe("db.internal");
      expect(resolved.user).toBe("app");
      // The input is not mutated: the caller may still hold it as the browser sent it.
      expect(browserConn.password).toBe("${MY_PASSWORD}");
    });

    it("names the missing variable, never a value", () => {
      process.env.MY_HOST = "db.internal";
      expect(() => resolveEnvPlaceholders(browserConn)).toThrow(
        'Environment variable MY_PASSWORD is not defined (referenced by field "password")',
      );
    });
  });
});
