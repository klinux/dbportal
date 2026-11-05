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
  /**
   * The token may send `approvedBy` on an execution: the people who already approved it
   * where the bot lives (a chat thread, a ticket). With it, a write on a datasource with
   * `writeApproval` runs at once instead of queueing; the bot is trusted to have counted
   * the approvers, so grant this only to a bot whose approval flow the operator reviewed.
   * A guardrail, a `review` hold and `requireApproval` still queue, whatever is declared.
   */
  trustedApprovals?: boolean;
  /**
   * Whether this token may DECIDE a pending execution it queued, naming the human reviewer
   * who chose (docs/CONTEXT.md §4.10). The named reviewer must pass the datasource's own
   * `approverRoles` (the same `canReview` the page and the Slack buttons use), so the token
   * can only relay a decision from someone the portal already recognizes as a reviewer. The
   * portal trusts the token that the named person really decided — same trust shape as
   * `trustedApprovals` — so grant it only to a bot whose decision flow the operator reviewed.
   */
  trustedReviews?: boolean;
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
  /** `namedRoles` is filled by the guard on every request (docs/CONTEXT.md §4.19), never stored. */
  session: { role: Role; username: string; groups?: string[]; namedRoles?: string[] };
}
