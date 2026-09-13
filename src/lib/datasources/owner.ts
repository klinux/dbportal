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
