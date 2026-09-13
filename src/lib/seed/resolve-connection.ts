import type { DatabaseConnection } from "@/lib/types";
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered, type ManagedConnection } from "./index";
import { logger } from "@/lib/logger";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { resolveEnvPlaceholders } from "./credential-resolver";
import { principalsOf } from "@/lib/access";

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

    return seedConn;
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
  try {
    return resolveEnvPlaceholders(connection);
  } catch (error) {
    throw new SeedConnectionError(error instanceof Error ? error.message : String(error), 400);
  }
}
