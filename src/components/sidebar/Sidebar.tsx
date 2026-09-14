"use client";

import React, { useState } from "react";
import { DatabaseConnection } from "@/lib/types";
import type { DatabaseObject } from "@/lib/db/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { Plus, Layers, LoaderCircle, CircleAlert, Search, X } from "lucide-react";
import { ObjectTree, type ObjectSource, type TreeRowActionHandlers } from "@/components/object-tree";
import { GitHubRepoLink } from "@/components/github-repo-link";
import { BrandMark, Wordmark } from "@/components/brand-mark";
import { getAppVersion } from "@/lib/app-version";
import { ConnectionPicker } from "./ConnectionPicker";

interface SidebarProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (connection: DatabaseConnection) => void;
  /**
   * Takes an administrator to where datasources are declared (docs/CONTEXT.md §4.1). Absent
   * for every other session: the button is then not rendered rather than rendered inert.
   */
  onAddConnection?: () => void;
  /** A row the reader activated, handed over whole: path, kind and the fields the tree loaded. */
  onObjectClick?: (object: DatabaseObject) => void;
  onShowDiagram?: () => void;
  /**
   * What the provider declares about this connection. The object tree is DRIVEN by the
   * declaration - the container levels decide what it reads first, and the kinds decide
   * which folders exist - so there is nothing to draw until it arrives.
   */
  metadata?: ProviderMetadata | null;
  /**
   * Why the declaration could not be read, in the route's own words (#789).
   *
   * Absence and failure are two different facts and the pending spinner below answers only
   * one of them: with no error the panel is waiting, with one it has nothing more to wait
   * for. The embedded workspace passes neither this nor the retry, because its host DECLARES
   * the capabilities rather than reading them, so there is no read to fail or to re-issue.
   */
  metadataError?: string | null;
  /** Read the declaration again. Absent means the shell has no way to, so none is offered. */
  onRetryMetadata?: () => void;
  /** The active connection reads no catalog until asked (#765). */
  objectScanDeferred?: boolean;
  /** Perform the read the active connection deferred. */
  onLoadObjects?: () => void;
  /**
   * What the tree's row menu may offer (U22, #789), handed straight through.
   *
   * The shell decides what it CAN do and the tree decides what the declaration ALLOWS, and
   * the sidebar joins neither question: the standalone app passes all six, the embedded
   * workspace passes the four it mounts a modal for.
   */
  objectActions?: TreeRowActionHandlers;
  /**
   * Who answers the object tree's reads, handed straight through (#789, B76).
   *
   * Absent is the standalone shell: the tree posts to this application's own object routes.
   * The embedded workspace supplies one, because the published package carries no routes and the
   * host is the only party that can reach the database.
   */
  objectSource?: ObjectSource;
  /**
   * Bumped by the shell when a statement it ran changed the catalog (#789), handed straight
   * through. The standalone shell drives it from the same DDL detection that re-reads the flat
   * inventory; the embedded workspace does not, because its host runs the statements.
   */
  objectRefreshToken?: number;
}

export function Sidebar({
  connections,
  activeConnection,
  onSelectConnection,
  onAddConnection,
  onObjectClick,
  onShowDiagram,
  metadata,
  metadataError = null,
  onRetryMetadata,
  objectScanDeferred = false,
  onLoadObjects,
  objectActions,
  objectSource,
  objectRefreshToken,
}: SidebarProps) {
  const appVersion = getAppVersion();
  const [filter, setFilter] = useState("");

  return (
    <div className="flex w-full h-full border-r border-border flex-col bg-background select-none">
      <div className="h-14 px-4 flex items-center justify-between border-b border-border">
        {/* App-header lockup: symbol 20px, frame stroke 4 at that size (docs/DESIGN.md §Logo). */}
        <div className="flex items-center gap-2.5 text-foreground">
          <BrandMark className="w-5 h-5" strokeWidth={4} />
          <Wordmark className="text-sm" />
        </div>
        <div className="flex items-center gap-1">
          {activeConnection && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={onShowDiagram}
              title="Show ERD Diagram"
            >
              <Layers strokeWidth={1.5} className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/*
        Two areas, each named (docs/CONTEXT.md §4.1, requested 2026-09-14): Connections, with
        the datasource row whose popover lists what this session may open, grouped by
        environment; and below it the Explorer of the one that is open.
      */}
      <section aria-label="Connections" data-testid="sidebar-connections" className="border-b border-border pb-3">
        <div className="h-9 px-3 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-fg-secondary">
            Connections
            <span className="font-mono text-[10px] text-fg-muted" data-testid="sidebar-connections-count">
              {connections.length}
            </span>
          </span>
          {onAddConnection && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={onAddConnection}
              title="New datasource"
            >
              <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="px-2">
          <ConnectionPicker
            connections={connections}
            activeConnection={activeConnection}
            onSelectConnection={onSelectConnection}
            onAddConnection={onAddConnection}
          />
        </div>
      </section>

      {activeConnection && (
        <div className="h-9 px-3 flex items-center justify-between shrink-0">
          <span className="text-xs font-medium text-fg-secondary">Explorer</span>
          <span className="truncate ml-2 text-[11px] text-fg-muted" title={activeConnection.name}>
            {activeConnection.name}
          </span>
        </div>
      )}
      {activeConnection && metadata && (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative">
            <Search strokeWidth={1.5} className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-muted" />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search loaded tables or objects…"
              aria-label="Search objects"
              data-testid="sidebar-explorer-search"
              className="w-full h-7 pl-7 pr-6 rounded-md border border-hairline bg-panel text-xs text-foreground placeholder:text-fg-muted focus:outline-none focus:border-hairline-strong"
            />
            {filter && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-fg-muted hover:text-foreground"
                onClick={() => setFilter("")}
                aria-label="Clear search"
              >
                <X strokeWidth={1.5} className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/*
        The object tree replaces the flat table list (#789). It reads the catalog itself,
        lazily, so the sidebar hands it the connection and the declaration and keeps no copy
        of what it found.

        Nothing is drawn while the declaration is missing, and that is not caution: an
        absent `containerLevels` reads as depth 0, which is a REAL answer for five engines,
        so a placeholder declaration would make a one-level engine read the counts of a
        container that does not exist instead of listing its schemas.
      */}
      {activeConnection && (
        <div className="flex-1 min-h-0 px-2 pb-4">
          {metadata ? (
            <ObjectTree
              connection={activeConnection}
              capabilities={metadata.capabilities}
              labels={metadata.labels}
              deferred={objectScanDeferred}
              onLoad={onLoadObjects}
              onObjectClick={onObjectClick}
              actions={objectActions}
              source={objectSource}
              refreshToken={objectRefreshToken}
              filter={filter}
            />
          ) : metadataError !== null ? (
            <div
              data-testid="sidebar-provider-failure"
              className="flex flex-col items-center justify-center py-12 px-4 text-center"
            >
              <CircleAlert strokeWidth={1.5} className="w-6 h-6 text-warning" />
              <h3 className="mt-3 text-foreground text-xs font-medium mb-1">This connection could not be read</h3>
              <p className="text-xs text-muted-foreground leading-relaxed break-words">{metadataError}</p>
              {onRetryMetadata !== undefined && (
                <button
                  type="button"
                  data-testid="sidebar-provider-retry"
                  onClick={onRetryMetadata}
                  className="mt-3 rounded-md bg-brand-solid hover:bg-brand-solid-hover text-white px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  Try again
                </button>
              )}
            </div>
          ) : (
            <div
              data-testid="sidebar-provider-pending"
              className="flex flex-col items-center justify-center py-12 text-muted-foreground"
            >
              <LoaderCircle strokeWidth={1.5} className="w-6 h-6 animate-spin text-brand/40" />
              <span className="mt-3 text-xs font-medium">Reading the connection...</span>
            </div>
          )}
        </div>
      )}

      <div className="p-3 border-t border-border bg-card/50 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/30 border border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-hue-green-tint animate-pulse" />
            <span className="text-xs font-medium text-muted-foreground">Connected</span>
          </div>
          <div className="flex items-center gap-2">
            {/*
              The sidebar is the one piece of chrome BOTH modes render - the
              standalone app and the embedded workspace, which supplies its own
              header - so the invitation to the repository lives here to reach
              every user rather than only the standalone ones.
            */}
            <GitHubRepoLink className="text-muted-foreground/70 hover:text-foreground" />
            {appVersion && <span className="text-xs font-mono text-muted-foreground/70">v{appVersion}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
