import { logger } from "@/lib/logger";
import { decryptConnections, decryptSshProfiles, encryptConnections, encryptSshProfiles } from "./connection-secrets";
import type {
  ApprovalQuery,
  ApprovalRequest,
  AuditEventFilter,
  AuditEventQuery,
  ServerStorageProvider,
  StorageCollection,
  StorageData,
  JobQuery,
  JobRecord,
  JobStatus,
  LeaseRecord,
} from "./types";
import type { DatabaseConnection } from "@/lib/types";
import type { AuditEvent } from "@/lib/audit";

/**
 * Credential encryption, applied ABOVE the ServerStorageProvider boundary.
 *
 * Why here and not inside each provider: one implementation means sqlite and postgres cannot
 * drift, a third provider inherits the control instead of having to remember it, and the
 * ciphertext stays portable so copying rows from a SQLite store into PostgreSQL still opens.
 * Neither shipped provider knows this exists; both simply receive a connection list whose secret
 * fields are already sealed and JSON.stringify it into their `data` column.
 *
 * Only `connections` and `ssh_profiles` are touched. No other collection carries a credential
 * field: history and saved_queries hold SQL text (the product's data, not its secrets),
 * audit_log is already sanitized by src/lib/audit.ts, and the remaining ones hold metadata.
 */

const CONNECTIONS: StorageCollection = "connections";
const SSH_PROFILES: StorageCollection = "ssh_profiles";

/**
 * Quoted verbatim in docs/STORAGE.md's troubleshooting section, and exported so the doc and the
 * code cannot drift into describing different messages.
 */
export const UNDECRYPTABLE_WARNING_PREFIX = "Stored connection secrets could not be decrypted";

/**
 * One line per read, carrying a count - not one line per field. A read happens on every page load
 * through the sync hook, and a per-field line would turn a single misconfiguration into a log
 * flood that buries the one thing the operator needs to see.
 */
function reportUndecryptable(count: number): void {
  if (count === 0) return;
  logger.warn(
    `${UNDECRYPTABLE_WARNING_PREFIX}: ${count} field(s) were omitted. Restore the previous JWT_SECRET (or STORAGE_ENCRYPTION_KEY) BEFORE the app writes again, or re-enter the affected credentials.`,
    { provider: "storage-encryption" },
  );
}

class CredentialEncryptingProvider implements ServerStorageProvider {
  constructor(private readonly inner: ServerStorageProvider) {}

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  isHealthy(): Promise<boolean> {
    return this.inner.isHealthy();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  // The audit record carries no credential by construction (src/lib/audit.ts sanitizes every
  // field before an event exists), so it passes through unsealed.
  appendAuditEvent(event: AuditEvent): Promise<void> {
    return this.inner.appendAuditEvent(event);
  }

  listAuditEvents(query: AuditEventQuery): Promise<AuditEvent[]> {
    return this.inner.listAuditEvents(query);
  }

  pruneAuditEvents(before: string): Promise<number> {
    return this.inner.pruneAuditEvents(before);
  }

  countAuditEvents(filter?: AuditEventFilter): Promise<number> {
    return this.inner.countAuditEvents(filter);
  }

  // Approval requests carry a statement and names, never a credential: passed through.
  putApproval(record: ApprovalRequest): Promise<void> {
    return this.inner.putApproval(record);
  }

  getApproval(id: string): Promise<ApprovalRequest | null> {
    return this.inner.getApproval(id);
  }

  listApprovals(query: ApprovalQuery): Promise<ApprovalRequest[]> {
    return this.inner.listApprovals(query);
  }

  // Jobs carry ids, a kind and a bounded payload the queue validated, never a credential: passed through.
  putJob(record: JobRecord): Promise<void> {
    return this.inner.putJob(record);
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.inner.getJob(id);
  }

  listJobs(query: JobQuery): Promise<JobRecord[]> {
    return this.inner.listJobs(query);
  }

  countJobs(status: JobStatus): Promise<number> {
    return this.inner.countJobs(status);
  }

  claimJob(kinds: string[], worker: string, now: string, leaseUntil: string): Promise<JobRecord | null> {
    return this.inner.claimJob(kinds, worker, now, leaseUntil);
  }

  heartbeatJob(id: string, worker: string, leaseUntil: string): Promise<boolean> {
    return this.inner.heartbeatJob(id, worker, leaseUntil);
  }

  reclaimJobs(now: string): Promise<JobRecord[]> {
    return this.inner.reclaimJobs(now);
  }

  pruneJobs(before: string): Promise<number> {
    return this.inner.pruneJobs(before);
  }

  acquireLease(name: string, holder: string, now: string, until: string): Promise<boolean> {
    return this.inner.acquireLease(name, holder, now, until);
  }

  listLeases(): Promise<LeaseRecord[]> {
    return this.inner.listLeases();
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    const data = await this.inner.getAllData(userId);
    if (!data.connections) return data;
    const { connections, undecryptable } = decryptConnections(data.connections);
    reportUndecryptable(undecryptable);
    return { ...data, connections };
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    const value = await this.inner.getCollection(userId, collection);
    if (value === null) return value;
    if (collection === SSH_PROFILES) {
      const { profiles, undecryptable } = decryptSshProfiles(value as unknown as Record<string, unknown>[]);
      reportUndecryptable(undecryptable);
      return profiles as unknown as StorageData[K];
    }
    if (collection !== CONNECTIONS) return value;
    // TypeScript cannot narrow StorageData[K] from a runtime comparison on K, so the two casts are
    // unavoidable; the runtime guard above is what makes them sound.
    const { connections, undecryptable } = decryptConnections(value as DatabaseConnection[]);
    reportUndecryptable(undecryptable);
    return connections as StorageData[K];
  }

  setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    if (collection === SSH_PROFILES) {
      return this.inner.setCollection(
        userId,
        collection,
        encryptSshProfiles(data as unknown as Record<string, unknown>[]) as unknown as StorageData[K],
      );
    }
    if (collection !== CONNECTIONS) return this.inner.setCollection(userId, collection, data);
    const sealed = encryptConnections(data as DatabaseConnection[]) as StorageData[K];
    return this.inner.setCollection(userId, collection, sealed);
  }

  mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    if (!data.connections) return this.inner.mergeData(userId, data);
    return this.inner.mergeData(userId, { ...data, connections: encryptConnections(data.connections) });
  }
}

export function withCredentialEncryption(provider: ServerStorageProvider): ServerStorageProvider {
  return new CredentialEncryptingProvider(provider);
}
