"use client";

import { BUILTIN_ENVIRONMENTS, type Environment, environmentOf } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The environment of a datasource, beside its name wherever one is picked from a list
 * (docs/CONTEXT.md §4.36). The same application lives in several environments under one
 * name - `smb` in production and `smb` in staging - and a picker that shows the name and
 * the engine alone shows two identical rows; the environment is what tells them apart.
 *
 * `environments` is the server's list when the caller has it (`useEnvironments`), the
 * built-ins otherwise: an environment the list lacks is shown under its own id, never
 * hidden. The `other` environment has no label and draws nothing.
 */
export function EnvironmentTag({
  environment,
  environments = BUILTIN_ENVIRONMENTS,
  className,
}: {
  environment?: string;
  environments?: readonly Environment[];
  className?: string;
}) {
  const label = environmentLabel(environment, environments);
  if (label === "") return null;
  const env = environmentOf(environments, environment);
  return (
    <span
      className={cn("shrink-0 rounded border px-1 text-[0.625rem] font-medium leading-4 tracking-wide", className)}
      style={{ borderColor: env.color, color: env.color }}
      data-testid="environment-tag"
    >
      {label}
    </span>
  );
}

/** The environment's label, or nothing for `other` and for a datasource that names none. */
export function environmentLabel(
  environment: string | undefined,
  environments: readonly Environment[] = BUILTIN_ENVIRONMENTS,
): string {
  if (!environment) return "";
  return environmentOf(environments, environment).label;
}

/** The label as a suffix for a plain `<option>`, where a styled tag cannot draw: " · PROD". */
export function environmentSuffix(environment: string | undefined, environments?: readonly Environment[]): string {
  const label = environmentLabel(environment, environments);
  return label === "" ? "" : ` · ${label}`;
}
