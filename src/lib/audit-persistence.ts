import { setAuditPersistence } from "@/lib/audit";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Wires the audit channel to the server store (docs/CONTEXT.md §4.2). Called once at boot
 * from src/instrumentation.ts; a no-op on STORAGE_PROVIDER=local, where the per-process
 * ring buffer and the stdout line are all there is. The provider is resolved lazily on the
 * first event rather than here, so a store that is slow to come up delays no boot and a
 * store that fails to come up fails the events, logged one by one, not the server.
 */
export function registerAuditPersistence(): void {
  if (!isServerStorageEnabled()) return;
  setAuditPersistence(async (event) => {
    const provider = await getStorageProvider();
    if (provider) await provider.appendAuditEvent(event);
  });
}
