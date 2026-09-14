import type { DatabaseConnection, QueryHistoryItem, SavedQuery, SchemaSnapshot, SavedChartConfig } from "../types";
import type { AuditEvent } from "../audit";
import type { MaskingConfig } from "../data-masking";
import type { ThresholdConfig } from "../monitoring-thresholds";
import type { SshProfileRecord } from "../ssh-profiles/types";
import type { Guardrail } from "../guardrails";
import type { ServiceTokenRecord } from "../service-tokens/types";
import type { FreezeWindowRecord } from "../freezes/store";
import type { NamedRoleRecord } from "../roles/store";
import type { RunbookRecord } from "../runbooks/store";
import type { EnvironmentRecord } from "../environments/store";
import type { ChannelRecord } from "../channels/store";
import type { AlertRecord } from "../alerts/store";
import type { TrailAlertsConfig } from "../trail-alerts/store";

/**
 * All persistable collections and their data types. Maps 1:1 with localStorage keys (minus
 * the `dbportal_` prefix). `connections` is no longer written by the browser - every
 * datasource is declared server-side (docs/CONTEXT.md §4.1) - and stays because the shared
 * datasource store keeps its records in that collection under a reserved owner.
 */
export interface StorageData {
  connections: DatabaseConnection[];
  history: QueryHistoryItem[];
  saved_queries: SavedQuery[];
  schema_snapshots: SchemaSnapshot[];
  saved_charts: SavedChartConfig[];
  active_connection_id: string | null;
  audit_log: AuditEvent[];
  masking_config: MaskingConfig;
  threshold_config: ThresholdConfig[];
  /**
   * SSH profiles (docs/CONTEXT.md §4.9), under the reserved owner only. Typed here so the
   * store reads it through the provider; deliberately NOT in STORAGE_COLLECTIONS, so the
   * per-user storage routes refuse the name and no browser ever writes one.
   */
  ssh_profiles: SshProfileRecord[];
  /** Service tokens (docs/CONTEXT.md §4.10): hashes and metadata under `shared:service-tokens`; not a per-user collection. */
  service_tokens: ServiceTokenRecord[];
  /** Freeze windows (docs/CONTEXT.md §4.17) under `shared:freezes`; not a per-user collection. */
  freeze_windows: FreezeWindowRecord[];
  /** Named roles (docs/CONTEXT.md §4.19), under the reserved owner `shared:roles`. */
  named_roles: NamedRoleRecord[];
  /** Runbooks (docs/CONTEXT.md §4.20), under the reserved owner `shared:runbooks`. */
  runbooks: RunbookRecord[];
  /** Environments (docs/CONTEXT.md §4.36), under the reserved owner `shared:environments`. */
  environments: EnvironmentRecord[];
  /** Notification channels (docs/CONTEXT.md §4.29), under `shared:channels`. */
  notification_channels: ChannelRecord[];
  /** Alerts (docs/CONTEXT.md §4.29), under `shared:alerts`; every owner's, told apart by the record. */
  alerts: AlertRecord[];
  /** Alerts on the trail (docs/CONTEXT.md §4.32): one document under `shared:channels`. */
  trail_alerts: TrailAlertsConfig;
}

/** Collection names that can be synced to server storage */
export type StorageCollection = keyof StorageData;

/** All persistable collection names */
export const STORAGE_COLLECTIONS: StorageCollection[] = [
  "connections",
  "history",
  "saved_queries",
  "schema_snapshots",
  "saved_charts",
  "active_connection_id",
  "audit_log",
  "masking_config",
  "threshold_config",
];

/** What the admin API asks the audit store for. */
/** The admin Audit page's question (docs/CONTEXT.md §4.27); every field but `limit` narrows. */
export interface AuditEventQuery {
  type?: string;
  /** The event's `user`. */
  actor?: string;
  connectionName?: string;
  result?: "success" | "failure";
  /** ISO instants, inclusive. */
  from?: string;
  to?: string;
  limit: number;
  offset?: number;
}

export type AuditEventFilter = Omit<AuditEventQuery, "limit" | "offset">;

/**
 * A write awaiting, granted or refused approval (docs/CONTEXT.md §4.6). `windowUntil` is the
 * end of the write window an approval opened for `requester` on `datasourceId`.
 */
/** `expired` (docs/CONTEXT.md §4.28): pending past APPROVAL_TTL_HOURS; the person asks again by running again. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDecision = "approve" | "reject";
export interface ApprovalRequest {
  id: string;
  datasourceId: string;
  datasourceName: string;
  requester: string;
  /** The statement that was refused, bounded; what the reviewer sees. */
  statement: string;
  route: string;
  status: ApprovalStatus;
  requestedAt: string;
  /** How many distinct approvals the datasource asked for (§4.28); absent is one. */
  approvalsRequired?: number;
  /** The approvals given so far when more than one is needed, in order. */
  approvals?: { reviewer: string; at: string }[];
  reviewer?: string;
  reviewedAt?: string;
  windowUntil?: string;
  note?: string;
  /**
   * `window` (the default, §4.6): a person present in the editor is granted minutes to run
   * again. `execution` (§4.10): a request a service token queued; approval runs THIS
   * statement on the server and stores the outcome here, the requester being absent.
   */
  kind?: "window" | "execution";
  /** Whom the service token acted for (a chat user id, an email): the person, not the bot. */
  subject?: string;
  /** Where the outcome is announced, when the request named a chat thread. */
  reply?: ExecutionReply;
  /** The signed callback the requester named (§4.25). */
  callback?: ExecutionCallback;
  /** The outcome of an `execution` request once it ran. */
  execution?: ExecutionOutcome;
  /** The guardrail the statement tripped (§4.15), when that is why the request exists. */
  guardrail?: Guardrail;
  /** The ticket or incident the requester named (§4.18). */
  ticket?: string;
}

export interface ExecutionReply {
  channel: string;
  threadTs?: string;
}

/** Where a bot outside Slack is told the outcome (docs/CONTEXT.md §4.25): an HTTPS URL on an allowed host. */
export interface ExecutionCallback {
  url: string;
}

export interface ExecutionOutcome {
  status: "done" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  rowCount?: number;
  /** The first rows, already masked, bounded in count and size; the rest is not kept. */
  fields?: string[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  /** A closed reason, never the driver's message. */
  error?: string;
}

export interface ApprovalQuery {
  status?: ApprovalStatus;
  requester?: string;
  datasourceId?: string;
  limit: number;
}

/**
 * Server-side storage provider interface.
 * Implements the Strategy Pattern — SQLite and PostgreSQL both implement this.
 *
 * Besides the per-user collections it also holds the audit record (docs/CONTEXT.md §4.2):
 * an APPEND-ONLY table no user can reach through the storage routes, read by the admin
 * API in place of the per-process ring buffer once a server store is configured. The
 * three methods below are the whole contract - there is no update and no delete.
 */
export interface ServerStorageProvider {
  /** Create tables if they don't exist */
  initialize(): Promise<void>;
  /** Append one audit event. Never overwrites: the id is the event's own, minted once. */
  appendAuditEvent(event: AuditEvent): Promise<void>;
  /** The most recent events, newest first, optionally of one type. */
  listAuditEvents(query: AuditEventQuery): Promise<AuditEvent[]>;
  /** How many events the store holds. */
  /** How many events the filter matches - the page's total - or every event without one. */
  countAuditEvents(filter?: AuditEventFilter): Promise<number>;
  /** Delete audit events older than `before` (ISO instant); the number removed (§4.12 retention). */
  pruneAuditEvents(before: string): Promise<number>;
  /** Write or replace one approval request by its id (§4.6). */
  putApproval(record: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  /** Newest first, filtered by whichever of status, requester and datasourceId are given. */
  listApprovals(query: ApprovalQuery): Promise<ApprovalRequest[]>;
  /** Get all collections for a user */
  getAllData(userId: string): Promise<Partial<StorageData>>;
  /** Get a single collection for a user */
  getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null>;
  /** Set a single collection for a user */
  setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void>;
  /** Merge multiple collections (used for migration) */
  mergeData(userId: string, data: Partial<StorageData>): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Cleanup resources */
  close(): Promise<void>;
}

/** Storage config returned by /api/storage/config */
export interface StorageConfigResponse {
  provider: "local" | "sqlite" | "postgres";
  serverMode: boolean;
}

/** Event dispatched on storage mutations */
export interface StorageChangeDetail {
  collection: StorageCollection;
  data: unknown;
}
