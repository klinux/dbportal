"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, TriangleAlert, UserRound } from "lucide-react";
import type { PortalUser, PortalUsers } from "@/lib/portal-users";

/**
 * Users (docs/CONTEXT.md §4.60): everybody seen signing in, newest first, with the role,
 * groups and method of their last sign-in and how many sign-ins the audit record holds for
 * them. Read-only - who may sign in is the identity provider's business, not this page's.
 */

/** How long ago an instant was, coarse on purpose: the last-seen date moves at most hourly. */
export function sinceLabel(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return "within the hour";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The groups a row shows before folding the rest into "+N". */
export const GROUPS_SHOWN = 3;

async function fetchUsers(): Promise<PortalUsers> {
  const res = await appFetch("/api/admin/users");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return (await res.json()) as PortalUsers;
}

function matches(user: PortalUser, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [user.username, user.role ?? "", ...(user.groups ?? [])].some((v) => v.toLowerCase().includes(needle));
}

export function UsersTab() {
  const [data, setData] = useState<PortalUsers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(
    () =>
      fetchUsers()
        .then((next) => {
          setData(next);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Users could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => (data ? data.users.filter((u) => matches(u, filter)) : []), [data, filter]);

  return (
    <div className="space-y-4" data-testid="users">
      <AdminSectionHeader
        icon={UserRound}
        title="Users"
        description="Everybody who has signed in to the portal, most recent first: the role and groups their last sign-in carried, and how often they sign in. Who may sign in is decided by the identity provider."
        testId="users-header"
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs gap-2"
            onClick={() => load()}
            disabled={!data && !error}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
            Refresh
          </Button>
        }
      />

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="users-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!data && !error ? (
        <div className="space-y-2" data-testid="users-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : data && !data.available ? (
        <p className="text-xs text-fg-muted" data-testid="users-unavailable">
          Sign-ins are remembered in the server store. This deployment runs without one (STORAGE_PROVIDER=local), so
          there is nobody to list.
        </p>
      ) : data ? (
        <>
          <div className="flex items-center gap-3">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by user, role or group..."
              aria-label="Filter users"
              className="h-8 max-w-xs text-xs"
            />
            <span className="text-xs text-fg-muted" data-testid="users-count">
              {visible.length} of {data.users.length}
            </span>
          </div>
          <div className="border border-hairline rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">User</TableHead>
                  <TableHead className="text-xs">Role</TableHead>
                  <TableHead className="text-xs">Groups</TableHead>
                  <TableHead className="text-xs">First sign-in</TableHead>
                  <TableHead className="text-xs">Last sign-in</TableHead>
                  <TableHead className="text-xs text-right">Sign-ins ({data.windowDays}d)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-xs text-fg-muted text-center py-6" data-testid="users-empty">
                      {data.users.length === 0 ? "Nobody has signed in yet." : "No user matches the filter."}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((user) => (
                    <TableRow key={user.username} data-testid={`user-row-${user.username}`}>
                      <TableCell className="text-xs max-w-[18rem] truncate" title={user.username}>
                        <span className="font-medium text-fg-secondary">{user.username}</span>
                        {user.method && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {user.method === "oidc" ? "SSO" : "password"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {user.role ? (
                          <Badge variant={user.role === "admin" ? "secondary" : "outline"} className="text-[10px]">
                            {user.role === "admin" ? "Administrator" : "User"}
                          </Badge>
                        ) : (
                          <span className="text-fg-muted" title="Recorded before roles were kept; shows after their next sign-in">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1" title={(user.groups ?? []).join(", ")}>
                          {(user.groups ?? []).slice(0, GROUPS_SHOWN).map((group) => (
                            <Badge key={group} variant="outline" className="text-[10px] font-mono">
                              {group}
                            </Badge>
                          ))}
                          {(user.groups?.length ?? 0) > GROUPS_SHOWN && (
                            <Badge variant="secondary" className="text-[10px]">
                              +{(user.groups?.length ?? 0) - GROUPS_SHOWN}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-fg-muted">
                        {new Date(user.firstSeenAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-xs text-fg-tertiary" title={new Date(user.lastSeenAt).toLocaleString()}>
                        {sinceLabel(user.lastSeenAt)}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-right text-fg-secondary">
                        {user.signIns === null ? "—" : user.signIns}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {data.countsCapped && (
            <p className="text-[11px] text-fg-muted" data-testid="users-capped">
              More sign-ins happened in the window than one listing reads; the counts are a floor.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
