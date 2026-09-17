/**
 * The engines an account of the portal's own can be provisioned on (docs/CONTEXT.md
 * §4.54). Pure, so the admin tab can decide whether a row offers the action without
 * pulling the server-side modules in.
 */

import type { DatabaseType } from "@/lib/types";

export type ProvisionEngine = "postgres" | "mysql";

export const PROVISIONABLE_TYPES: readonly ProvisionEngine[] = ["postgres", "mysql"];

export function canProvisionAccount(type: DatabaseType | string | undefined): type is ProvisionEngine {
  return (PROVISIONABLE_TYPES as readonly string[]).includes(type ?? "");
}
