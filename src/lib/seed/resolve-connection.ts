import type { DatabaseConnection } from "@/lib/types";
import { withStoredSecret } from "@/lib/datasources/store";
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered, type ManagedConnection } from "./index";
import { logger } from "@/lib/logger";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { resolveEnvPlaceholders } from "./credential-resolver";
import { principalsOf } from "@/lib/access";
import { resolveVaultReferences } from "@/lib/vault/credentials";
import { VaultError } from "@/lib/vault/client";
import { applySshProfile, SshProfileResolutionError } from "@/lib/ssh-profiles/resolve";

/**
 * What the audit line names as the target of a refused client-supplied connection. There is
 * no route to name: `resolveConnection` serves every `src/app/api/db/*` route and does not
 * know which one called it. Exported so the tests assert the same string the trail carries.
 */
export const CLIENT_CONNECTION_TARGET = "connection:client-supplied";

export class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}

export async function resolveConnection(
  body: { connection?: DatabaseConnection; connectionId?: string },
  session: { role: string; username: string; groups?: string[] },
): Promise<ManagedConnection> {
  const { connection, connectionId } = body;

  if (connection && !connectionId) {
    // A connection the CLIENT describes (host, user, password) is no longer a way to reach a
    // database: datasources are declared by an administrator and referenced by id
    // (docs/CONTEXT.md §4.1). For a non-admin session it is recorded as a ROLE denial - the
    // caller has a session, just not the role that could ever have used this path - and the
    // body itself is never logged: it carries the credential. The one place a connection
    // object is still read is `resolveDraftConnection` below, for testing a draft.
    if (session.role !== "admin") {
      logger.warn("Client-supplied connection refused for non-admin session", {
        route: "seed/resolve-connection",
        user: session.username,
        role: session.role,
      });
      auditRoleDenial({ route: CLIENT_CONNECTION_TARGET, user: session.username });
      throw new SeedConnectionError(
        "Only administrators can supply a connection; select a managed connection instead",
        403,
      );
    }
    throw new SeedConnectionError(
      "Client-supplied connections are not accepted; declare the datasource under Admin → Datasources and send its connectionId",
      400,
    );
  }

  if (connectionId) {
    if (!connectionId.startsWith("seed:")) {
      throw new SeedConnectionError("Invalid connection ID format", 400);
    }

    const seedId = connectionId.slice(5);
    const seedConn = await getSeedConnectionById(seedId, principalsOf(session));

    if (!seedConn) {
      const exists = await getSeedConnectionByIdUnfiltered(seedId);
      if (exists) {
        logger.warn("Seed connection access denied", {
          route: "seed/resolve-connection",
          connectionId: seedId,
          user: session.username,
          role: session.role,
        });
        throw new SeedConnectionError(
          `Access denied: connection "${seedId}" not available for role "${session.role}"`,
          403,
        );
      }
      throw new SeedConnectionError(`Seed connection "${seedId}" not found`, 404);
    }

    logger.debug("Resolved seed connection", {
      route: "seed/resolve-connection",
      connectionId: seedId,
      user: session.username,
    });

    // A virtual datasource (§4.44) is its members, each resolved as this person would
    // resolve it: the access rule, the Vault reference, the read-only pool. A member the
    // person may not open is the same 403 it would be alone; nothing is attached before.
    if (seedConn.type === "virtual") {
      const memberConnections: ManagedConnection[] = [];
      for (const id of seedConn.members ?? []) {
        memberConnections.push(await resolveConnection({ connectionId: `seed:${id}` }, session));
      }
      return { ...seedConn, memberConnections };
    }

    return withSshProfile(await withVaultCredentials(seedConn, session.username));
  }

  throw new SeedConnectionError("connectionId is required", 400);
}

/**
 * A datasource an administrator is about to save, tested before it is (docs/CONTEXT.md §4.1
 * step B). The one path that still reads a connection object off a request, and it exists
 * for `POST /api/db/test-connection` alone: the editor tests the draft, then saves the same
 * fields to the admin API. Admin only, audited like every other role denial. A `${ENV_VAR}`
 * reference is resolved here, so the draft is tested with the credential the server holds
 * and saved with the reference - the value never travels through the browser. A reference
 * the server cannot resolve is the caller's mistake, and the message names the variable,
 * never a value.
 */
export async function resolveDraftConnection(
  connection: DatabaseConnection,
  session: { role: string; username: string },
): Promise<DatabaseConnection> {
  if (session.role !== "admin") {
    logger.warn("Draft connection refused for non-admin session", {
      route: "seed/resolve-connection",
      user: session.username,
      role: session.role,
    });
    auditRoleDenial({ route: CLIENT_CONNECTION_TARGET, user: session.username });
    throw new SeedConnectionError("Only administrators can test a connection draft", 403);
  }
  let resolved: DatabaseConnection;
  try {
    // An edit of a shared datasource is tested with the secret the store holds (§4.48).
    resolved = resolveEnvPlaceholders(await withStoredSecret(connection));
  } catch (error) {
    throw new SeedConnectionError(error instanceof Error ? error.message : String(error), 400);
  }
  return withSshProfile(await withVaultCredentials(resolved, session.username));
}

/**
 * The tunnel a datasource's SSH profile describes (docs/CONTEXT.md §4.9), built here so the
 * datasource record never carries the bastion's secrets. A declaration that names an
 * unknown profile or an unset variable is a 400 that says so; a Vault that does not answer
 * is the same 503 as for a credential.
 */
async function withSshProfile<T extends DatabaseConnection>(conn: T): Promise<T> {
  try {
    return await applySshProfile(conn);
  } catch (error) {
    if (error instanceof SshProfileResolutionError) throw new SeedConnectionError(error.message, error.statusCode);
    if (error instanceof VaultError) {
      logger.error("SSH profile secret could not be obtained", error, {
        route: "seed/resolve-connection",
        connectionId: conn.id,
      });
      throw new SeedConnectionError(
        `The SSH profile of "${conn.name}" could not be resolved from the secrets manager`,
        503,
      );
    }
    throw error;
  }
}

/**
 * A `vault:` reference resolved for the person opening the datasource (docs/CONTEXT.md
 * §4.5). What Vault said is logged here, server-side; the client learns that the
 * credential could not be obtained and for which datasource - a 503, since the datasource
 * is declared correctly and the secrets manager is what did not answer. A malformed
 * reference is the declaration's fault and a 400 that says so.
 */
async function withVaultCredentials<T extends DatabaseConnection>(conn: T, subject: string): Promise<T> {
  try {
    return await resolveVaultReferences(conn, subject);
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    logger.error("Vault credential could not be obtained", error, {
      route: "seed/resolve-connection",
      connectionId: conn.id,
      user: subject,
    });
    if (error.message.startsWith("Malformed Vault reference")) {
      throw new SeedConnectionError(`Datasource "${conn.name}" declares a malformed Vault reference`, 400);
    }
    throw new SeedConnectionError(`Credentials for "${conn.name}" could not be obtained from the secrets manager`, 503);
  }
}
