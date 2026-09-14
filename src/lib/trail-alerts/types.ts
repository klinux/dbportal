/** The vocabulary of the trail alerts (docs/CONTEXT.md §4.32), shared with the browser; the store stays on the server. */
export const TRAIL_RULES = ["guardrail", "production_export", "backup_failed", "seed_failed"] as const;
export type TrailRule = (typeof TRAIL_RULES)[number];

export const TRAIL_RULE_LABELS: Record<TrailRule, string> = {
  guardrail: "A guardrail fired",
  production_export: "A large export left production",
  backup_failed: "A backup failed",
  seed_failed: "A seed run failed",
};

export interface TrailAlertsConfig {
  rules: Record<TrailRule, string[]>;
  /** How many rows an export must carry to count as large. */
  exportRowsThreshold: number;
}
