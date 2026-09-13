import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import type { SeedConnection } from "./types";

const ENV_VAR_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const RESOLVABLE_FIELDS = ["password", "connectionString", "user", "host", "database"] as const;

const warnedPlaintext = new Set<string>();

export function resetPlaintextWarnings(): void {
  warnedPlaintext.clear();
}

function resolveField(value: string | undefined, fieldName: string, connId: string): string | undefined {
  if (value === undefined) return undefined;

  const match = value.match(ENV_VAR_PATTERN);
  if (!match) {
    if (fieldName === "password" && value.length > 0 && !warnedPlaintext.has(connId)) {
      warnedPlaintext.add(connId);
      logger.warn("Seed connection has plaintext password, use ${ENV_VAR} syntax", {
        route: "seed/credential-resolver",
        connectionId: connId,
      });
    }
    return value;
  }

  const envVar = match[1];
  const envValue = process.env[envVar];
  if (envValue === undefined) {
    throw new Error(
      `Environment variable ${envVar} is not defined (required by seed connection "${connId}" field "${fieldName}")`,
    );
  }

  return envValue;
}

export function resolveConnectionCredentials(conn: SeedConnection): SeedConnection {
  const resolved = { ...conn };
  for (const field of RESOLVABLE_FIELDS) {
    const value = resolved[field];
    if (typeof value === "string") {
      (resolved as Record<string, unknown>)[field] = resolveField(value, field, conn.id);
    }
  }
  return resolved;
}

/**
 * The same `${ENV_VAR}` reference a seed file may carry, honoured in a connection an admin
 * typed into the browser (docs/CONTEXT.md §4.1 step B): the datasource can be TESTED with the
 * credential the server holds before it is saved with the same reference, and the credential
 * never travels to the browser at all. No plaintext warning here - a browser connection is
 * expected to carry its value. A reference to a variable the server does not have is an
 * error the caller turns into a 400, never a silent literal `${...}` password.
 */
export function resolveEnvPlaceholders(conn: DatabaseConnection): DatabaseConnection {
  const resolved: Record<string, unknown> = { ...conn };
  for (const field of RESOLVABLE_FIELDS) {
    const value = resolved[field];
    if (typeof value !== "string") continue;
    const match = value.match(ENV_VAR_PATTERN);
    if (!match) continue;
    const envValue = process.env[match[1]];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${match[1]} is not defined (referenced by field "${field}")`);
    }
    resolved[field] = envValue;
  }
  return resolved as unknown as DatabaseConnection;
}

export function resolveAllCredentials(connections: SeedConnection[]): SeedConnection[] {
  const results: SeedConnection[] = [];
  for (const conn of connections) {
    try {
      results.push(resolveConnectionCredentials(conn));
    } catch (err) {
      logger.error("Seed connection skipped due to credential resolution failure", err, {
        route: "seed/credential-resolver",
        connectionId: conn.id,
      });
    }
  }
  return results;
}
