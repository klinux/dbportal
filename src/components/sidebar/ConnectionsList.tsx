"use client";

import React, { useMemo } from "react";
import { Eye, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { getDBIcon } from "@/lib/db-ui-config";
import { BUILTIN_ENVIRONMENTS, type Environment, environmentOf, type DatabaseConnection } from "@/lib/types";
import { useEnvironments } from "@/hooks/use-environments";
import { cn } from "@/lib/utils";

/**
 * The datasources this session may open, grouped by environment in the order the admin
 * page uses (production first), with a search box above them: a fleet has many.
 * One list for two surfaces: the desktop sidebar wraps it in a popover
 * (`ConnectionPicker`), the mobile connections tab renders it inline.
 */
interface ConnectionsListProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  /** Absent when the session may not declare datasources; the empty state then says who can. */
  onAddConnection?: () => void;
  /** Focus the search box on mount - the popover does, the inline tab does not steal focus. */
  autoFocus?: boolean;
}

export interface EnvironmentGroup {
  env: string;
  label: string;
  color: string;
  connections: DatabaseConnection[];
}

/**
 * The listing's order (docs/CONTEXT.md §4.36): production first, then the rest as the
 * environments list orders them, and whatever declared no environment - or one the list
 * does not know - after, under its own name.
 */
export function groupByEnvironment(
  connections: readonly DatabaseConnection[],
  environments: readonly Environment[] = BUILTIN_ENVIRONMENTS,
): EnvironmentGroup[] {
  const byEnv = new Map<string, DatabaseConnection[]>();
  for (const conn of connections) {
    const env = conn.environment ?? "other";
    byEnv.set(env, [...(byEnv.get(env) ?? []), conn]);
  }
  return [...byEnv.keys()]
    .map((id) => environmentOf(environments, id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((environment) => ({
      env: environment.id,
      label: environment.label || "Other",
      color: environment.color,
      connections: byEnv.get(environment.id)!,
    }));
}

export function ConnectionsList({
  connections,
  activeConnection,
  onSelectConnection,
  onAddConnection,
  autoFocus = false,
}: ConnectionsListProps) {
  const environments = useEnvironments();
  const groups = useMemo(() => groupByEnvironment(connections, environments), [connections, environments]);

  if (connections.length === 0) {
    return (
      <div
        data-testid="connections-empty"
        className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-2"
      >
        {onAddConnection ? (
          <>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">No datasources declared yet.</p>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAddConnection}>
              New datasource
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground leading-relaxed">
            No connections have been shared with you yet. Ask an administrator.
          </p>
        )}
      </div>
    );
  }

  return (
    <Command data-testid="connections-list" loop className="bg-transparent">
      {/* Always there (requested 2026-09-14): a fleet has many datasources, and the box is how one is found. */}
      <CommandInput placeholder="Search datasources…" autoFocus={autoFocus} className="text-xs" />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty className="py-4 text-center text-xs text-fg-muted">No datasource matches.</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup
            key={group.env}
            data-testid={`connections-group-${group.env}`}
            heading={
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: group.color }} />
                {group.label}
              </span>
            }
          >
            {group.connections.map((conn) => {
              const active = activeConnection?.id === conn.id;
              const key = conn.seedId || conn.id;
              return (
                <CommandItem
                  key={conn.id}
                  // The search matches on this: the name, and the id so two "Orders" stay distinct.
                  value={`${conn.name} ${key}`}
                  onSelect={() => onSelectConnection(conn)}
                  data-testid={`connection-${key}`}
                  data-active={active ? "true" : "false"}
                  className={cn("cursor-pointer text-xs gap-2", active && "bg-brand-solid/10 text-brand")}
                >
                  {React.createElement(getDBIcon(conn.type), { className: "w-3.5 h-3.5 shrink-0" })}
                  <span className="truncate flex-1 font-medium">{conn.name}</span>
                  {conn.readOnly && (
                    <span data-testid={`read-only-${key}`} className="text-fg-muted" title="Read-only for you">
                      <Eye strokeWidth={1.5} className="w-3 h-3" />
                    </span>
                  )}
                  {conn.managed && (
                    <span
                      data-testid={`managed-lock-${key}`}
                      className="text-warning/60"
                      title="Managed by administrator"
                    >
                      <Lock strokeWidth={1.5} className="w-3 h-3" />
                    </span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
