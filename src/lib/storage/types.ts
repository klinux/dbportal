import type { DatabaseConnection, QueryHistoryItem, SavedQuery, SchemaSnapshot, SavedChartConfig } from "../types";
import type { AuditEvent } from "../audit";
import type { MaskingConfig } from "../data-masking";
import type { ThresholdConfig } from "../monitoring-thresholds";
import type { SshProfileRecord } from "../ssh-profiles/types";

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
export interface AuditEventQuery {
  type?: string;
  limit: number;
}

/**
 * A write awaiting, granted or refused approval (docs/CONTEXT.md §4.6). `windowUntil` is the
 * end of the write window an approval opened for `requester` on `datasourceId`.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected";
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
  reviewer?: string;
  reviewedAt?: string;
  windowUntil?: string;
  note?: string;
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
  countAuditEvents(): Promise<number>;
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
