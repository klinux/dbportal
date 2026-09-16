import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import path from "path";
import type { DatabaseConnection } from "@/lib/types";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
process.env.ADMIN_PG_PASS = "admin-secret";
process.env.USER_MYSQL_PASS = "user-secret";
process.env.SHARED_PG_PASS = "shared-secret";
process.env.BOTH_PG_PASS = "both-secret";

import {
  resolveConnection,
  resolveDraftConnection,
  SeedConnectionError,
  CLIENT_CONNECTION_TARGET,
} from "@/lib/seed/resolve-connection";
import { resetCache } from "@/lib/seed/config-loader";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetVaultCache } from "@/lib/vault/credentials";

const clientConn: DatabaseConnection = {
  id: "user-conn",
  name: "User DB",
  type: "postgres",
  host: "db.internal.example",
  user: "app",
  password: "hunter2",
  createdAt: new Date(),
};

describe("resolve-connection", () => {
  beforeEach(() => {
    resetCache();
    clearRateLimitState();
  });

  // docs/CONTEXT.md §4.1: datasources are declared by an administrator and referenced by
  // id. An admin sending a connection object is not a role problem, it is the wrong door -
  // a 400 that names the right one.
  it("refuses a client-supplied connection from an admin with 400, naming the datasource page", async () => {
    try {
      await resolveConnection({ connection: clientConn }, { role: "admin", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(400);
      expect((err as SeedConnectionError).message).toContain("Datasources");
    }
  });

  // Step B: a draft is what the admin editor tests before saving. A `${VAR}` reference is
  // resolved server-side so the draft is tested with the credential the server holds; a
  // reference the server cannot resolve is the caller's mistake (400), and the message names
  // the variable, not a value.
  it("resolveDraftConnection resolves an admin's ${VAR} references and refuses an unresolvable one with 400", async () => {
    process.env.STEP_B_PASS = "resolved-secret";
    try {
      const resolved = await resolveDraftConnection(
        { ...clientConn, password: "${STEP_B_PASS}" },
        { role: "admin", username: "test" },
      );
      expect(resolved.password).toBe("resolved-secret");
    } finally {
      delete process.env.STEP_B_PASS;
    }
    try {
      await resolveDraftConnection({ ...clientConn, password: "${STEP_B_PASS}" }, { role: "admin", username: "t" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(400);
      expect((err as SeedConnectionError).message).toContain("STEP_B_PASS");
    }
  });

  // A draft is an admin's to test. Anyone else probing the route leaves the same role-denial
  // trail a client-supplied connection does.
  it("resolveDraftConnection refuses a non-admin with 403 and audits it", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await resolveDraftConnection(clientConn, { role: "user", username: "bob" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
      const lines = logSpy.mock.calls.map(
        (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0].reason).toBe("insufficient_role");
      expect(lines[0].route).toBe(CLIENT_CONNECTION_TARGET);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // docs/CONTEXT.md §4.1 step A: a client-supplied connection was the one path where any
  // authenticated user could make the server connect to a host of their choosing. The refusal
  // has to happen here, before a provider is built, because 12 routes share this resolver.
  it("throws 403 for a non-admin session that supplies its own connection", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await resolveConnection({ connection: clientConn }, { role: "user", username: "bob" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // The denial is a ROLE denial and is recorded as one in the stdout channel, with the same
  // reason the admin-only routes use, so an operator filtering on `insufficient_role` sees
  // both kinds of probing in one place.
  it("audits the refused client connection as permission_denied / insufficient_role", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await resolveConnection({ connection: clientConn }, { role: "user", username: "bob" }).catch(() => {});
      const lines = logSpy.mock.calls.map(
        (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0].event).toBe("permission_denied");
      expect(lines[0].reason).toBe("insufficient_role");
      expect(lines[0].actor).toBe("bob");
      expect(lines[0].route).toBe(CLIENT_CONNECTION_TARGET);
      // No request reaches the resolver, so the line must not invent an address.
      expect(lines[0].ip).toBeUndefined();
      // The refused body carries the credential; none of it may reach the trail.
      const raw = logSpy.mock.calls[0][0] as string;
      expect(raw).not.toContain("hunter2");
      expect(raw).not.toContain("db.internal.example");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // `connectionId` wins when both are present: the seed path already checks the role, so a
  // non-admin body that also carries a stray `connection` is not refused for it.
  it("ignores a stray connection object when a connectionId is present", async () => {
    const result = await resolveConnection(
      { connection: clientConn, connectionId: "seed:everyone" },
      { role: "user", username: "test" },
    );
    expect(result.id).toBe("seed:everyone");
  });

  it("resolves seed connection by connectionId", async () => {
    const result = await resolveConnection({ connectionId: "seed:everyone" }, { role: "user", username: "test" });
    expect(result.id).toBe("seed:everyone");
    expect(result.password).toBe("shared-secret");
  });

  it("throws 403 when role does not have access", async () => {
    try {
      await resolveConnection({ connectionId: "seed:admin-only" }, { role: "user", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
    }
  });

  // docs/CONTEXT.md §4.4: a group in the token opens what the role alone would not, and
  // the resolved datasource carries its write rule for the routes to enforce.
  it("resolves by group principal and carries writeRoles", async () => {
    const asUser = await resolveConnection({ connectionId: "seed:readonly-everyone" }, { role: "user", username: "t" });
    expect(asUser.writeRoles).toEqual(["group:dba"]);
    const asSre = await resolveConnection(
      { connectionId: "seed:readonly-everyone" },
      { role: "user", username: "t", groups: ["sre"] },
    );
    expect(asSre.id).toBe("seed:readonly-everyone");
    try {
      await resolveConnection({ connectionId: "seed:admin-only" }, { role: "user", username: "t", groups: ["sre"] });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as SeedConnectionError).statusCode).toBe(403);
    }
  });

  // docs/CONTEXT.md §4.5: a datasource whose credential Vault issues is opened with a
  // credential issued for THIS person; what Vault said stays in the server log, and the
  // client learns only that the credential could not be obtained (503) - or, for a
  // reference the declaration got wrong, that the declaration is at fault (400).
  describe("Vault references", () => {
    const savedAddr = process.env.VAULT_ADDR;
    const savedToken = process.env.VAULT_TOKEN;
    const savedRenew = process.env.VAULT_TOKEN_RENEW;
    type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const fetchHolder = globalThis as unknown as { fetch: FetchLike };
    let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
    let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
    let logSpy: ReturnType<typeof spyOn<Console, "log">>;

    beforeEach(() => {
      resetVaultCache();
      process.env.VAULT_ADDR = "https://vault.internal";
      process.env.VAULT_TOKEN = "s.token";
      // The token's self-renewal is the client's own test; off here so every request counted is a secret's.
      process.env.VAULT_TOKEN_RENEW = "off";
      fetchSpy = spyOn(fetchHolder, "fetch").mockImplementation(
        async () =>
          new Response(JSON.stringify({ lease_duration: 60, data: { username: "v-ana", password: "issued-pw" } }), {
            status: 200,
          }),
      );
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      if (savedAddr === undefined) delete process.env.VAULT_ADDR;
      else process.env.VAULT_ADDR = savedAddr;
      if (savedToken === undefined) delete process.env.VAULT_TOKEN;
      else process.env.VAULT_TOKEN = savedToken;
      if (savedRenew === undefined) delete process.env.VAULT_TOKEN_RENEW;
      else process.env.VAULT_TOKEN_RENEW = savedRenew;
    });

    it("resolves a seed datasource's db reference for the session's person", async () => {
      const resolved = await resolveConnection(
        { connectionId: "seed:vault-orders" },
        { role: "user", username: "ana" },
      );
      expect(resolved.user).toBe("v-ana");
      expect(resolved.password).toBe("issued-pw");
      expect(String((fetchSpy.mock.calls[0] as [string])[0])).toContain("/v1/database/creds/orders");
    });

    it("answers 503 without Vault's words when the credential cannot be obtained", async () => {
      fetchSpy.mockImplementation(
        async () => new Response(JSON.stringify({ errors: ["permission denied"] }), { status: 403 }),
      );
      const err = await resolveConnection(
        { connectionId: "seed:vault-orders" },
        { role: "user", username: "ana" },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(503);
      expect((err as SeedConnectionError).message).toBe(
        'Credentials for "Orders via Vault" could not be obtained from the secrets manager',
      );
      expect(errorSpy).toHaveBeenCalled();
    });

    it("answers 400 for a malformed reference, naming the datasource", async () => {
      const err = await resolveConnection(
        { connectionId: "seed:vault-broken" },
        { role: "user", username: "ana" },
      ).catch((e) => e);
      expect((err as SeedConnectionError).statusCode).toBe(400);
      expect((err as SeedConnectionError).message).toContain("malformed Vault reference");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("resolves a reference in an admin's draft too, so the draft is tested with the issued credential", async () => {
      const draft = await resolveDraftConnection(
        { ...clientConn, password: "vault:db:database/orders" },
        { role: "admin", username: "root" },
      );
      expect(draft).toMatchObject({ user: "v-ana", password: "issued-pw" });
    });
  });

  it("throws 404 when seed connection does not exist", async () => {
    try {
      await resolveConnection({ connectionId: "seed:nonexistent" }, { role: "admin", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(404);
    }
  });

  it("admin can access admin-only connections", async () => {
    const result = await resolveConnection({ connectionId: "seed:admin-only" }, { role: "admin", username: "test" });
    expect(result.password).toBe("admin-secret");
  });

  it("throws 400 when neither connection nor connectionId", async () => {
    try {
      await resolveConnection({}, { role: "admin", username: "test" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(400);
    }
  });
});
