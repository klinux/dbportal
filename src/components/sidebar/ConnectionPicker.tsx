"use client";

import React, { useState } from "react";
import { ChevronsUpDown, Database, Eye } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getDBIcon } from "@/lib/db-ui-config";
import { type DatabaseConnection, environmentOf } from "@/lib/types";
import { useEnvironments } from "@/hooks/use-environments";
import { cn } from "@/lib/utils";
import { ConnectionsList } from "./ConnectionsList";

/**
 * The desktop sidebar's datasource control: one row showing what is open, and a popover
 * with the grouped, searchable list. A flat list of every datasource took the top of the
 * sidebar away from the object tree, which is what the sidebar is for once something is open.
 */
interface ConnectionPickerProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onAddConnection?: () => void;
}

export function ConnectionPicker({
  connections,
  activeConnection,
  onSelectConnection,
  onAddConnection,
}: ConnectionPickerProps) {
  const [open, setOpen] = useState(false);
  const environments = useEnvironments();
  const env = activeConnection?.environment ? environmentOf(environments, activeConnection.environment) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Datasource"
          data-testid="connection-picker"
          className={cn(
            "w-full h-9 px-3 flex items-center gap-2 rounded-lg border text-xs transition-colors",
            "bg-panel border-hairline hover:bg-raised hover:border-hairline-strong",
            activeConnection ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {activeConnection ? (
            React.createElement(getDBIcon(activeConnection.type), { className: "w-3.5 h-3.5 shrink-0" })
          ) : (
            <Database strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="truncate flex-1 text-left font-medium">
            {activeConnection?.name ?? "Choose a datasource"}
          </span>
          {env && env.label && (
            <span
              className="text-[0.5rem] font-medium px-1.5 py-0.5 rounded-sm shrink-0"
              style={{ color: env.color, backgroundColor: `${env.color}22` }}
            >
              {env.label}
            </span>
          )}
          {activeConnection?.readOnly && (
            <span
              data-testid="connection-picker-read-only"
              className="text-fg-muted shrink-0"
              title="Read-only for you"
            >
              <Eye strokeWidth={1.5} className="w-3 h-3" />
            </span>
          )}
          <ChevronsUpDown strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-muted shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0">
        <ConnectionsList
          connections={connections}
          activeConnection={activeConnection}
          autoFocus
          onSelectConnection={(conn) => {
            onSelectConnection(conn);
            setOpen(false);
          }}
          onAddConnection={
            onAddConnection
              ? () => {
                  setOpen(false);
                  onAddConnection();
                }
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  );
}
