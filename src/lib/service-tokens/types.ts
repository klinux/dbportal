import type { Role } from "@/lib/auth";

/**
 * A service token (docs/CONTEXT.md §4.10): the identity a bot presents as a Bearer. The
 * secret is shown once at creation and only its hash is stored; the token carries a role
 * and groups like any principal, so every datasource access rule applies to it unchanged.
 */
export interface ServiceTokenRecord {
  id: string;
  /** A short name; the audit actor is `svc:<name>`. */
  name: string;
  role: Role;
  groups?: string[];
  /** Datasource ids the token may name; empty means any its role and groups allow. */
  datasources?: string[];
  /** Every request queues for a reviewer, reads included. */
  requireApproval: boolean;
  /** SHA-256 of the secret, hex. */
  secretHash: string;
  /** The first characters of the secret, so an operator can tell tokens apart. */
  prefix: string;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
  lastUsedAt?: string;
}

/** What the admin API returns: everything but the hash. */
export type ServiceTokenView = Omit<ServiceTokenRecord, "secretHash">;

/** The identity a valid Bearer resolves to: the record, and the session shape the rest of the server speaks. */
export interface ServiceIdentity {
  token: ServiceTokenRecord;
  session: { role: Role; username: string; groups?: string[] };
}
