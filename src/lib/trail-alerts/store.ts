import { z } from "zod";
import { SHARED_CHANNELS_OWNER } from "@/lib/datasources/owner";
import { logger } from "@/lib/logger";
import { getStorageProvider } from "@/lib/storage/factory";

/**
 * Alerts on the trail (docs/CONTEXT.md §4.32): four things the audit channel says that an
 * operator wants told at once - a guardrail fired, a large export left production, a backup
 * failed, a seed failed - each sent to the channels an administrator picked (§4.29). One
 * configuration document, kept with the channels under their reserved owner; the defaults
 * name no channel, so nothing fires until someone asks.
 */
import { TRAIL_RULE_LABELS, TRAIL_RULES, type TrailAlertsConfig, type TrailRule } from "./types";

export { TRAIL_RULE_LABELS, TRAIL_RULES, type TrailAlertsConfig, type TrailRule };

const ChannelIds = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(10);
export const TrailAlertsSchema = z.object({
  rules: z.object({
    guardrail: ChannelIds,
    production_export: ChannelIds,
    backup_failed: ChannelIds,
    seed_failed: ChannelIds,
  }),
  /** How many rows an export must carry to count as large. */
  exportRowsThreshold: z.number().int().min(1).max(10_000_000),
});

export const DEFAULT_TRAIL_ALERTS: TrailAlertsConfig = {
  rules: { guardrail: [], production_export: [], backup_failed: [], seed_failed: [] },
  exportRowsThreshold: 1000,
};

export class TrailAlertsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "TrailAlertsError";
  }
}

const COLLECTION = "trail_alerts" as const;
const CACHE_TTL_MS = 5_000;
let cache: { at: number; config: TrailAlertsConfig } | null = null;

/** Tests only. */
export function resetTrailAlertsCache(): void {
  cache = null;
}

/** The configuration in force: the stored one, or the defaults. Never throws - the observer reads this on every event. */
export async function getTrailAlerts(): Promise<TrailAlertsConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.config;
  let config = DEFAULT_TRAIL_ALERTS;
  try {
    const store = await getStorageProvider();
    const stored = store ? await store.getCollection(SHARED_CHANNELS_OWNER, COLLECTION) : null;
    const parsed = stored ? TrailAlertsSchema.safeParse(stored) : null;
    if (parsed?.success) config = parsed.data;
    else if (stored) logger.warn("Stored trail alerts are malformed; using the defaults", { route: "trail-alerts" });
  } catch (error) {
    logger.error("Trail alerts could not be read; using the defaults", error, { route: "trail-alerts" });
  }
  cache = { at: Date.now(), config };
  return config;
}

export async function saveTrailAlerts(input: unknown, by: string): Promise<TrailAlertsConfig> {
  const parsed = TrailAlertsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TrailAlertsError(`Invalid trail alerts: ${issue.path.join(".") || "body"} ${issue.message}`, 400);
  }
  const store = await getStorageProvider();
  if (!store)
    throw new TrailAlertsError("Trail alerts need server storage: set STORAGE_PROVIDER to sqlite or postgres", 503);
  await store.setCollection(SHARED_CHANNELS_OWNER, COLLECTION, parsed.data);
  cache = { at: Date.now(), config: parsed.data };
  logger.info("Trail alerts saved", { route: "trail-alerts", user: by });
  return parsed.data;
}
