/**
 * Who may have rows generated into a datasource, decided once for every surface that
 * offers it.
 *
 * Two surfaces generate rows: the admin's seed panel (`run.ts`, on the server) and the
 * studio's "Generate Test Data" row action, which composes INSERT statements in the
 * browser and runs them through the ordinary query path. The admin rule refused a
 * production datasource from the start; the studio's menu did not read the environment
 * at all, so an operator with write rights on production was offered a button that
 * writes invented rows into it. One rule, imported by both, so the two cannot disagree
 * again. Pure and dependency-free, because the studio runs it in the browser.
 */

import type { DatabaseConnection } from "@/lib/types";

/** The admin's own sentence, shared so the studio refuses in the same words. */
export const PRODUCTION_SEED_REFUSAL = "A production datasource is never seeded";

/**
 * Why rows must not be generated into this datasource, or null when they may.
 *
 * The environment is the datasource's declaration and the read-only flag is the
 * server's per-session decision (docs/CONTEXT.md §4.4); both travel on the connection
 * the studio already holds. The studio's refusal is a UI gate and not a security
 * boundary - a generated INSERT is an ordinary statement, and what protects a
 * production datasource from one is the write policy the query route enforces
 * (write roles, approvals, tickets, freezes). This keeps the studio from OFFERING
 * what the policy would then have to refuse.
 */
export function testDataRefusal(
  connection: Pick<DatabaseConnection, "environment" | "readOnly"> | null | undefined,
): string | null {
  if (!connection) return "No datasource is open";
  if (connection.environment === "production") return PRODUCTION_SEED_REFUSAL;
  if (connection.readOnly === true)
    return "This session may not write to the datasource, so no rows can be generated into it";
  return null;
}
