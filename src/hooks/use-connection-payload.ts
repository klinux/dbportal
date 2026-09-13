import type { DatabaseConnection } from "@/lib/types";

/** A seed connection as `GET /api/connections/managed` serializes it. */
export type ManagedConnectionPayload = Omit<DatabaseConnection, "createdAt"> & { createdAt: string; seedId?: string };

/**
 * The `reason` `GET /api/connections/managed` puts on its 500 when the failure was its
 * own seed configuration rather than anything else in the request.
 *
 * A bare 500 says only "this request failed", and a browser reading that cannot tell it
 * from "the server serves no seeds" — which is a legitimate answer, and the one a
 * default deployment gets when no seed file exists. Naming the failure is what lets the
 * client hold "I do not have the seed list" instead of "the list is empty" (B37).
 */
export const SEED_CONFIG_UNREADABLE_REASON = "seed-config-unreadable";

/**
 * Why a connection has no id a run may be started on: the server cannot rebuild it. Every
 * datasource is declared server-side (docs/CONTEXT.md §4.1), so this is only a stale row
 * from before that change.
 */
type UnresolvableConnectionReason = "browser-only";

/** The id a run may be started on, or the reason there is none. */
export type AgentRunConnection =
  | { readonly id: string; readonly reason?: undefined }
  | { readonly id: null; readonly reason: UnresolvableConnectionReason };

/**
 * The connection portion of an API request body: a reference, never the connection. Every
 * datasource is declared server-side and opened by its seed id (docs/CONTEXT.md §4.1), so no
 * credential travels with a request. A connection without a seed id can only be a stale row
 * from before that change; its own id goes out and the server answers 400 rather than 403.
 */
export function buildConnectionPayload(conn: DatabaseConnection): { connectionId: string } {
  return { connectionId: conn.seedId ? `seed:${conn.seedId}` : conn.id };
}

/**
 * The id a run may be STARTED on. A run persists a connection id and no credential, so
 * whatever it stores has to still mean the same database after a restart; a seed reference
 * does, because the server rebuilds it from its own declaration (docs/CONTEXT.md §4.1). A
 * row without a seed id predates that rule and cannot be re-resolved.
 */
export function resolveAgentRunConnectionId(conn: DatabaseConnection): AgentRunConnection {
  return conn.seedId ? { id: `seed:${conn.seedId}` } : { id: null, reason: "browser-only" };
}
