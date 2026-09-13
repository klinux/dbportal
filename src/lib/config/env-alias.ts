import { logger } from "@/lib/logger";

/**
 * The product's environment variables are `DBPORTAL_*` (docs/CONTEXT.md §5, rebrand layer
 * 3). The `LIBREDB_*` names the snapshot inherited keep working for one release: a value
 * under the old name is read when the new one is unset, and the first such read logs once
 * so an operator learns what to rename before the fallback goes.
 */
export const ENV_PREFIX = "DBPORTAL_";
export const LEGACY_ENV_PREFIX = "LIBREDB_";

const warned = new Set<string>();

/** Tests only: forget which legacy names were already reported. */
export function resetLegacyEnvWarnings(): void {
  warned.clear();
}

/** `process.env.DBPORTAL_<name>`, or the legacy `LIBREDB_<name>` when only that is set. */
export function readEnv(name: string): string | undefined {
  const current = process.env[`${ENV_PREFIX}${name}`];
  if (current !== undefined) return current;
  const legacy = process.env[`${LEGACY_ENV_PREFIX}${name}`];
  if (legacy !== undefined && !warned.has(name)) {
    warned.add(name);
    logger.warn(
      `${LEGACY_ENV_PREFIX}${name} is deprecated; set ${ENV_PREFIX}${name} instead (the old name is read for one release)`,
      {
        route: "config/env-alias",
      },
    );
  }
  return legacy;
}
