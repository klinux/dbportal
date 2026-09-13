import * as fs from "fs";
import { loadConfig } from "./config-loader";
import { resolveAllCredentials } from "./credential-resolver";
import { filterByRoles, mergeDefaults } from "./connection-filter";
import { isSampleEnabled, resolveSamplePath, buildSampleConnection } from "./libredb-sample";
import {
  isSqliteSampleEnabled,
  resolveSqliteSamplePath,
  buildSqliteSampleConnection,
  getSqliteSampleSeedState,
  SQLITE_SAMPLE_SEED_ID,
} from "./sqlite-sample";
import type { ManagedConnection, SeedConnection } from "./types";
import { listSharedDatasources } from "@/lib/datasources/store";
import { logger } from "@/lib/logger";
import { readEnv } from "@/lib/config/env-alias";

export type { ManagedConnection } from "./types";
export { resetCache } from "./config-loader";

/** The ids the seed YAML declares. An id here is taken; the runtime store may not reuse it. */
export async function getConfigSeedIds(): Promise<Set<string>> {
  const config = await loadConfig();
  return new Set(config ? config.connections.map((conn) => conn.id) : []);
}

/**
 * Every declared datasource, from both sources, before credentials are resolved: the seed
 * YAML first, then the shared store (docs/CONTEXT.md §4.1 step B). The YAML wins an id
 * collision, because what is declared in version control is the operator's explicit
 * statement and a runtime record cannot silently override it. A store that cannot be read
 * costs the runtime records only - the YAML datasources keep working, and the failure is
 * logged rather than turned into an empty list for everyone.
 */
async function collectDeclared(): Promise<SeedConnection[]> {
  const config = await loadConfig();
  const fromConfig = config ? config.connections.map((conn) => mergeDefaults(conn, config.defaults)) : [];
  const declared = new Set(fromConfig.map((conn) => conn.id));
  let shared: SeedConnection[] = [];
  try {
    shared = (await listSharedDatasources()).filter((record) => !declared.has(record.id));
  } catch (error) {
    logger.error("Shared datasources could not be read; serving the seed config only", error, {
      route: "seed/index",
    });
  }
  return [...fromConfig, ...shared];
}

async function loadAndResolve(): Promise<ManagedConnection[]> {
  const declared = await collectDeclared();
  if (declared.length === 0) return [];
  return filterByRoles(resolveAllCredentials(declared), ["*", "admin", "user"]);
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const fromConfig = filterByRoles(resolveAllCredentials(await collectDeclared()), roles);

  const out = [...fromConfig];

  /*
    The SQLite sample leads the built-ins, and the order is the point: a client with
    no persisted active connection selects the first of this list, so whichever sample
    comes first is what a brand-new user lands on. The agent runtime targets
    PostgreSQL and SQLite; the LibreDB engine has no database-native read-only
    execution profile, so leading with it put every zero-config user on the one
    connection an agent run can never execute against. An operator's own seed config
    still leads both — those are already in `out`.

    In a test run, only consider a sample when its explicit path override is set, so
    an uncontrolled real ./data/sample.* cannot perturb unrelated suites.
    (NODE_ENV==='test' guard mirrors the existing pattern in src/lib/db/factory.ts.)
  */
  const sqliteSampleConsidered = process.env.NODE_ENV !== "test" || !!process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
  if (isSqliteSampleEnabled() && sqliteSampleConsidered) {
    try {
      if (fs.existsSync(resolveSqliteSamplePath())) {
        out.push(buildSqliteSampleConnection());
      }
    } catch {
      /* fs error -> omit the sample */
    }
  }

  const libredbSampleConsidered = process.env.NODE_ENV !== "test" || !!readEnv("EMBEDDED_SAMPLE_PATH");
  if (isSampleEnabled() && libredbSampleConsidered) {
    try {
      if (fs.existsSync(resolveSamplePath())) {
        out.push(buildSampleConnection());
      }
    } catch {
      /* fs error -> omit the sample */
    }
  }

  return out;
}

/**
 * Seed ids whose async seeding is still in flight — advertised by the managed
 * connections API so clients poll until the sample appears (or seeding ends).
 * Empty when nothing is seeding: embedded in platform, instrumentation never
 * runs, the state stays "idle", and clients never poll.
 */
export function getPendingSeeds(): string[] {
  if (isSqliteSampleEnabled() && getSqliteSampleSeedState() === "seeding") {
    return [SQLITE_SAMPLE_SEED_ID];
  }
  return [];
}

export async function getSeedConnectionById(seedId: string, roles: string[]): Promise<ManagedConnection | null> {
  const all = await getManagedConnections(roles);
  return all.find((c) => c.seedId === seedId) ?? null;
}

export async function getSeedConnectionByIdUnfiltered(seedId: string): Promise<ManagedConnection | null> {
  const all = await loadAndResolve();
  return all.find((c) => c.seedId === seedId) ?? null;
}
