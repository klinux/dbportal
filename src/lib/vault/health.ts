import { getVaultConfig, isVaultConfigured } from "./client";

/**
 * Whether Vault answers (docs/CONTEXT.md §4.13), for the readiness probe: `sys/health`
 * with standby answers accepted, bounded by a short timeout of its own so a slow Vault
 * makes the probe say "not ready" rather than hang it. Unconfigured is "skipped": a
 * deployment without Vault is not unready for lacking one.
 */
export type CheckOutcome = "ok" | "failed" | "skipped";
export const HEALTH_TIMEOUT_MS = 2_000;

export async function vaultHealthy(): Promise<CheckOutcome> {
  if (!isVaultConfigured()) return "skipped";
  try {
    const config = getVaultConfig();
    const res = await fetch(`${config.addr}/v1/sys/health?standbyok=true&perfstandbyok=true`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: "no-store",
      ...(config.namespace ? { headers: { "X-Vault-Namespace": config.namespace } } : {}),
    });
    // 200 active, 429 standby (accepted above), 473 performance standby; anything else is sealed or down.
    return res.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}
