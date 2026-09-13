import { z } from "zod";
import { emitAuditEvent } from "@/lib/audit";
import {
  DEFAULT_MASKING_CONFIG,
  applyMaskingToRows,
  canReveal,
  detectSensitiveColumnsFromConfig,
  shouldMask,
  type MaskingConfig,
} from "@/lib/data-masking";
import { SHARED_MASKING_OWNER } from "@/lib/datasources/owner";
import { logger } from "@/lib/logger";
import { getStorageProvider } from "@/lib/storage/factory";
import { MaskingError } from "./errors";

/**
 * Server-side masking (docs/CONTEXT.md §4.7). The masking configuration is ONE record an
 * administrator owns, held in the server store under a reserved owner, and applied to
 * every result before it leaves the execution routes - the browser never receives a value
 * the rule masks. Without a server store the built-in defaults apply, so a deployment that
 * has not configured anything still masks the obvious columns.
 *
 * Reveal is a request (`reveal: true`), allowed to the roles the configuration names, and
 * audited every time it uncovers something (DESIGN.md: "unmasking is itself an audited
 * action"). The rules themselves are the same pure functions the grid uses, so what the
 * server hides and what the grid marks agree by construction.
 */
const COLLECTION = "masking_config" as const;
const CACHE_TTL_MS = 5_000;
const MAX_PATTERNS = 100;
const MAX_COLUMN_PATTERNS = 50;

export { MaskingError };

const RoleSettingSchema = z.object({ canToggle: z.boolean(), canReveal: z.boolean() });

/** The configuration as an administrator may save it: bounded, and every column pattern a regex that compiles. */
export const MaskingConfigSchema = z.object({
  enabled: z.boolean(),
  patterns: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(64),
        columnPatterns: z
          .array(
            z
              .string()
              .min(1)
              .max(128)
              .refine((pattern) => {
                try {
                  RegExp(`^${pattern}$`, "i");
                  return true;
                } catch {
                  return false;
                }
              }, "must be a valid regular expression"),
          )
          .max(MAX_COLUMN_PATTERNS),
        maskType: z.enum(["email", "phone", "card", "ssn", "full", "partial", "ip", "date", "financial", "custom"]),
        enabled: z.boolean(),
        isBuiltin: z.boolean(),
        customMask: z.string().max(64).optional(),
      }),
    )
    .max(MAX_PATTERNS),
  roleSettings: z.object({ admin: RoleSettingSchema, user: RoleSettingSchema }),
});

let cache: { at: number; config: MaskingConfig } | null = null;

/** Tests only: forget what this process has read. */
export function resetMaskingConfigCache(): void {
  cache = null;
}

/** The configuration in force: the stored one, or the defaults. Never throws - a store that cannot be read masks by the defaults and says so in the log. */
export async function getServerMaskingConfig(): Promise<MaskingConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.config;
  let config: MaskingConfig = DEFAULT_MASKING_CONFIG;
  try {
    const store = await getStorageProvider();
    const stored = store ? await store.getCollection(SHARED_MASKING_OWNER, COLLECTION) : null;
    const parsed = stored ? MaskingConfigSchema.safeParse(stored) : null;
    if (parsed?.success) config = parsed.data;
    else if (stored)
      logger.warn("Stored masking configuration is malformed; masking by the defaults", { route: "masking/store" });
  } catch (error) {
    logger.error("Masking configuration could not be read; masking by the defaults", error, { route: "masking/store" });
  }
  cache = { at: Date.now(), config };
  return config;
}

export async function saveServerMaskingConfig(input: unknown, by: string): Promise<MaskingConfig> {
  const parsed = MaskingConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MaskingError(`Invalid masking configuration: ${issue.path.join(".") || "body"} ${issue.message}`, 400);
  }
  const store = await getStorageProvider();
  if (!store)
    throw new MaskingError(
      "Saving the masking configuration needs server storage: set STORAGE_PROVIDER to sqlite or postgres",
      503,
    );
  await store.setCollection(SHARED_MASKING_OWNER, COLLECTION, parsed.data);
  cache = { at: Date.now(), config: parsed.data };
  logger.info("Masking configuration saved", { route: "masking/store", user: by });
  return parsed.data;
}

export interface MaskableResult {
  rows: Record<string, unknown>[];
  fields: string[];
}

/** Who asked, on which datasource, and whether they asked to see the values. */
export interface MaskingContext {
  session: { role: string; username: string };
  connectionName: string;
  reveal?: boolean;
}

/**
 * The result as it may leave the server for this session: masked columns replaced by their
 * masked form, and `masked` naming them so the grid can mark them without guessing. A reveal
 * the session may not make is a 403 - the person asked for something and is told no, rather
 * than being quietly served the masked rows they did not ask for.
 */
export async function maskResult<T extends MaskableResult>(
  result: T,
  context: MaskingContext,
): Promise<T & { masked: string[] }> {
  const config = await getServerMaskingConfig();
  const sensitive = detectSensitiveColumnsFromConfig(result.fields, config);
  const columns = [...sensitive.keys()];
  if (context.reveal) {
    if (!canReveal(context.session.role, config)) throw new MaskingError("You may not reveal masked values", 403);
    if (columns.length > 0) recordReveal(context.session.username, context.connectionName, columns);
    return { ...result, masked: [] };
  }
  if (columns.length === 0 || !shouldMask(context.session.role, config)) return { ...result, masked: [] };
  return { ...result, rows: applyMaskingToRows(result.rows, result.fields, sensitive), masked: columns };
}

function recordReveal(user: string, connectionName: string, columns: string[]): void {
  // Isolated like every other emit after the decision: a broken sink must not turn a
  // permitted reveal into a 500 - but the columns are named, never their values.
  try {
    emitAuditEvent({
      type: "masking_reveal",
      action: "reveal",
      target: columns.join(","),
      connectionName,
      user,
      result: "success",
    });
  } catch (auditError) {
    logger.error("Failed to record masking_reveal audit event", auditError, { route: "masking/store" });
  }
}
