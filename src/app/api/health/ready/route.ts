import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import { type CheckOutcome, vaultHealthy } from "@/lib/vault/health";

/**
 * GET /api/health/ready (docs/CONTEXT.md §4.13): whether this instance can serve. Two
 * dependencies, each checked only when configured - the server store (STORAGE_PROVIDER
 * sqlite or postgres) and Vault (VAULT_ADDR) - and 503 while either fails, so a rollout
 * keeps the old pod until the new one can actually answer. Public, like every probe; the
 * body names outcomes, never addresses or errors.
 */
async function storeHealthy(): Promise<CheckOutcome> {
  if (!isServerStorageEnabled()) return "skipped";
  try {
    const provider = await getStorageProvider();
    if (!provider) return "failed";
    return (await provider.isHealthy()) ? "ok" : "failed";
  } catch (error) {
    logger.warn("Readiness: the server store did not answer", {
      route: "GET /api/health/ready",
      error: (error as Error).name,
    });
    return "failed";
  }
}

export async function GET() {
  const [store, vault] = await Promise.all([storeHealthy(), vaultHealthy()]);
  const ready = store !== "failed" && vault !== "failed";
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", checks: { store, vault }, timestamp: new Date().toISOString() },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
