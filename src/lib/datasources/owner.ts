/**
 * The `user_storage` owner the shared datasource store lives under.
 *
 * Shared datasources are stored in the same table and the same `connections` collection as a
 * user's own connections, so they inherit credential encryption at the one choke point every
 * storage write passes through (src/lib/storage/factory.ts). What keeps them apart from any
 * user's rows is this owner id, and what keeps any user from becoming it is `login()` in
 * src/lib/auth.ts, which refuses to mint a session for it - whatever an identity provider
 * claims as the subject. In its own module so both sides import the constant, not each other.
 */
export const SHARED_DATASOURCES_OWNER = "shared:datasources";

/** The owner the one shared masking configuration lives under (docs/CONTEXT.md §4.7). */
export const SHARED_MASKING_OWNER = "shared:masking";

/** The owner the shared SSH profiles live under (docs/CONTEXT.md §4.9). */
export const SHARED_SSH_PROFILES_OWNER = "shared:ssh-profiles";
/** Service tokens (docs/CONTEXT.md §4.10): hashes only, never a secret. */
export const SHARED_SERVICE_TOKENS_OWNER = "shared:service-tokens";
/** Freeze windows (docs/CONTEXT.md §4.17). */
export const SHARED_FREEZES_OWNER = "shared:freezes";
/** Named roles (docs/CONTEXT.md §4.19). */
export const SHARED_ROLES_OWNER = "shared:roles";
/** Runbooks (docs/CONTEXT.md §4.20). */
export const SHARED_RUNBOOKS_OWNER = "shared:runbooks";
/** Environments (docs/CONTEXT.md §4.36). */
export const SHARED_ENVIRONMENTS_OWNER = "shared:environments";
/** Notification channels (docs/CONTEXT.md §4.29). */
export const SHARED_CHANNELS_OWNER = "shared:channels";
/** Alerts (docs/CONTEXT.md §4.29). */
export const SHARED_ALERTS_OWNER = "shared:alerts";
/** The people and groups seen signing in (docs/CONTEXT.md §4.49). */
export const SHARED_PRINCIPALS_OWNER = "shared:principals";

/** Every owner id no account may ever be. */
export const RESERVED_OWNERS: readonly string[] = [
  SHARED_DATASOURCES_OWNER,
  SHARED_MASKING_OWNER,
  SHARED_SSH_PROFILES_OWNER,
  SHARED_SERVICE_TOKENS_OWNER,
  SHARED_FREEZES_OWNER,
  SHARED_ROLES_OWNER,
  SHARED_RUNBOOKS_OWNER,
  SHARED_ENVIRONMENTS_OWNER,
  SHARED_CHANNELS_OWNER,
  SHARED_ALERTS_OWNER,
  SHARED_PRINCIPALS_OWNER,
];
