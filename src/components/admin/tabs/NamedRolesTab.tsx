"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";
import { PrincipalPicker } from "@/components/admin/PrincipalPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CONFIG_SHEET_CLASS } from "@/lib/ui/config-sheet";
import { Plus, RefreshCw, Trash2, TriangleAlert, Users } from "lucide-react";
import { toast } from "sonner";

/**
 * Named roles (docs/CONTEXT.md §4.19): an id every datasource list refers to as
 * `role:<id>`, and who is in it - a portal role, a group from the identity provider, or a
 * person by username. Declared here or in the seed file (read-only here).
 */
export interface NamedRoleView {
  id: string;
  name: string;
  members: string[];
  source: "config" | "store";
  createdBy?: string;
}

interface Draft {
  name: string;
  members: string[];
}

const EMPTY: Draft = { name: "", members: [] };

export function slugifyRoleId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** One member per line or comma; blank lines dropped; duplicates kept once. */
export function parseMembers(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

async function fetchRoles(): Promise<NamedRoleView[]> {
  const res = await appFetch("/api/admin/roles");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { roles: NamedRoleView[] }).roles;
}

export function NamedRolesTab() {
  const [roles, setRoles] = useState<NamedRoleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<NamedRoleView | null>(null);

  const load = useCallback(
    () =>
      fetchRoles()
        .then((list) => {
          setRoles(list);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Named roles could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const id = slugifyRoleId(draft.name);
    const members = [...new Set(draft.members)];
    if (!id || !draft.name.trim() || members.length === 0) {
      toast.error("A name and at least one member are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: draft.name.trim(), members }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the role (${res.status})`);
      toast.success(`Role "${draft.name.trim()}" declared`);
      setOpen(false);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The role could not be declared");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`/api/admin/roles/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`Role "${target.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The role could not be deleted");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="named-roles">
      <AdminSectionHeader
        icon={Users}
        title="Roles"
        description="A name declared once for who may open, write or review: a group from the identity provider, a portal role, or a person. Datasources refer to it as role:<id> in roles, writeRoles and approverRoles."
        testId="named-roles-header"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => load()}
              disabled={!roles && !error}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Refresh
            </Button>
            <Button size="sm" className="h-8 text-xs gap-2" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New role
            </Button>
          </>
        }
      />

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="named-roles-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!roles && !error ? (
        <div className="space-y-2" data-testid="named-roles-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : roles && roles.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="named-roles-empty">
          No named role. Datasources name groups and portal roles directly.
        </p>
      ) : roles ? (
        <div className="border border-hairline rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Role</TableHead>
                <TableHead className="text-xs">Members</TableHead>
                <TableHead className="text-xs text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role.id} data-testid={`role-${role.id}`}>
                  <TableCell className="text-xs">
                    <div className="font-medium text-fg-primary">{role.name}</div>
                    <div className="font-mono text-[10px] text-fg-muted">role:{role.id}</div>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-fg-muted">{role.members.join(", ")}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {role.source === "config" ? (
                      <Badge
                        variant="secondary"
                        className="text-[10px]"
                        title="Declared in the seed file; edit it there"
                      >
                        seed file
                      </Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-status-danger"
                        onClick={() => setPendingDelete(role)}
                        aria-label={`Delete ${role.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Sheet open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="named-role-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <Users strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">New role</SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                Members are group:&lt;name&gt; for a group the identity provider sends, user:&lt;username&gt; for one
                person, or admin / user for a portal role. A role is never a member of a role.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="role-name" className="text-xs text-fg-tertiary">
                  Name
                </Label>
                <Input
                  id="role-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="On-call"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {draft.name && (
                  <p className="text-[11px] font-mono text-fg-muted">role:{slugifyRoleId(draft.name) || "—"}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-fg-tertiary">Members</Label>
                {/* docs/CONTEXT.md §4.37: picked from what the deployment knows, or typed once. */}
                <PrincipalPicker
                  value={draft.members}
                  onChange={(members) => setDraft({ ...draft, members })}
                  kinds={["role", "group", "user"]}
                  placeholder="Add member"
                  idPrefix="members"
                  label="Add a member"
                />
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={create} disabled={saving}>
              Declare role
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this role?</AlertDialogTitle>
            <AlertDialogDescription>
              Every datasource list that names role:{pendingDelete?.id} stops matching at once; nobody gains or keeps
              access through it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete role</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
