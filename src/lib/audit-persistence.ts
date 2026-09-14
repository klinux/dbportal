import { setAuditPersistence, toAuditLine, type AuditEvent } from "@/lib/audit";
import { elasticConfig, enqueueAuditExport } from "@/lib/audit-export/elastic";
import { logger } from "@/lib/logger";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Wires the audit channel to what keeps a copy of it (docs/CONTEXT.md §4.2, §4.12). Called
 * once at boot from src/instrumentation.ts. Two destinations, each optional: the server
 * store (STORAGE_PROVIDER sqlite or postgres), and Elasticsearch (AUDIT_ELASTIC_URL). With
 * neither, the per-process ring buffer and the stdout line are all there is.
 *
 * The provider is resolved lazily on the first event rather than here, so a store that is
 * slow to come up delays no boot and a store that fails to come up fails the events, logged
 * one by one, not the server. Retention (AUDIT_RETENTION_DAYS) is swept from the same
 * path, at most once an hour, after an append - there is no scheduler to keep alive.
 */
export const RETENTION_SWEEP_MS = 60 * 60 * 1000;
const SWEEP_KEY = Symbol.for("dbportal.audit-retention-sweep");

export function retentionDays(): number | null {
  const days = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isInteger(days) && days > 0 ? days : null;
}

/** Whether a sweep is due: the last one is remembered on globalThis, one stamp per process. */
function sweepDue(now: number): boolean {
  const holder = globalThis as unknown as { [SWEEP_KEY]?: number };
  if (holder[SWEEP_KEY] !== undefined && now - holder[SWEEP_KEY] < RETENTION_SWEEP_MS) return false;
  holder[SWEEP_KEY] = now;
  return true;
}

/** Tests only. */
export function resetRetentionSweep(): void {
  delete (globalThis as unknown as { [SWEEP_KEY]?: number })[SWEEP_KEY];
}

async function appendToStore(event: AuditEvent): Promise<void> {
  const provider = await getStorageProvider();
  if (!provider) return;
  await provider.appendAuditEvent(event);
  const days = retentionDays();
  if (days === null || !sweepDue(Date.now())) return;
  try {
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const removed = await provider.pruneAuditEvents(before);
    if (removed > 0) logger.info("Audit events past retention removed", { route: "audit", removed, days });
  } catch (error) {
    // The append already landed; a failed sweep is retried an hour later.
    logger.warn("Audit retention sweep failed", { route: "audit", error: (error as Error).name });
  }
}

export function registerAuditPersistence(): void {
  const toStore = isServerStorageEnabled();
  const toElastic = elasticConfig() !== null;
  if (!toStore && !toElastic) return;
  setAuditPersistence(async (event) => {
    // The exporter queues and returns; only the store is awaited, and its failure is the
    // caller's to log (emitAuditEvent does, once per event).
    if (toElastic) enqueueAuditExport(toAuditLine(event) as unknown as Record<string, unknown>);
    if (toStore) await appendToStore(event);
  });
}
