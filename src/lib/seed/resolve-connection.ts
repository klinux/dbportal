import type { DatabaseConnection } from "@/lib/types";
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered } from "./index";
import { logger } from "@/lib/logger";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { resolveEnvPlaceholders } from "./credential-resolver";

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
  session: { role: string; username: string },
): Promise<DatabaseConnection> {
  const { connection, connectionId } = body;

  if (connection && !connectionId) {
    // A connection the CLIENT describes (host, user, password) is the one path where the
    // server connects to whatever the caller typed. Datasources are created once, by an admin,
    // and shared (docs/CONTEXT.md §4.1); for any other role this branch would let a user reach
    // any host the portal can, under any credential they hold. Refused before anything is
    // connected, and recorded as a ROLE denial: the caller has a session, just not the role
    // the action requires. The body itself is never logged - it carries the credential.
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
    // An admin may write `${ENV_VAR}` where a seed file would, so a datasource is tested with
    // the credential the server holds and then saved with the reference (step B). A reference
    // the server cannot resolve is the caller's mistake, and the message names the variable -
    // never its value.
    try {
      return resolveEnvPlaceholders(connection);
    } catch (error) {
      throw new SeedConnectionError(error instanceof Error ? error.message : String(error), 400);
    }
  }

  if (connectionId) {
    if (!connectionId.startsWith("seed:")) {
      throw new SeedConnectionError("Invalid connection ID format", 400);
    }

    const seedId = connectionId.slice(5);
    const seedConn = await getSeedConnectionById(seedId, [session.role]);

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

  throw new SeedConnectionError("Either connection or connectionId is required", 400);
}
