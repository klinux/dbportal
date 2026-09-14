"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";
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
import { Layers, Pencil, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

/**
 * Environments (docs/CONTEXT.md §4.36): the labels datasources are filed under, with a
 * colour and an order. The five built-ins can be relabelled and recoloured; new ones can
 * be declared; a stored one can be deleted when no datasource uses it; `production` stays.
 */
export interface EnvironmentView {
  id: string;
  label: string;
  color: string;
  order: number;
  source: "builtin" | "config" | "store";
}

interface Draft {
  id: string;
  label: string;
  color: string;
  order: string;
}

const EMPTY: Draft = { id: "", label: "", color: "#6b7280", order: "10" };

export function slugifyEnvironmentId(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

async function fetchEnvironments(): Promise<EnvironmentView[]> {
  const res = await appFetch("/api/admin/environments");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { environments: EnvironmentView[] }).environments;
}

export function EnvironmentsTab() {
  const [environments, setEnvironments] = useState<EnvironmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EnvironmentView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EnvironmentView | null>(null);

  const load = useCallback(
    () =>
      fetchEnvironments()
        .then((list) => {
          setEnvironments(list);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Environments could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = () => {
    setEditing(null);
    setDraft(EMPTY);
    setOpen(true);
  };

  const startEdit = (env: EnvironmentView) => {
    setEditing(env);
    setDraft({ id: env.id, label: env.label, color: env.color, order: String(env.order) });
    setOpen(true);
  };

  const save = async () => {
    const id = editing ? editing.id : slugifyEnvironmentId(draft.id || draft.label);
    const order = Number(draft.order);
    if (!id || !draft.label.trim() || !Number.isInteger(order)) {
      toast.error("A label, an id and a whole-number order are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch("/api/admin/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, label: draft.label.trim(), color: draft.color, order }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the environment (${res.status})`);
      toast.success(`Environment "${draft.label.trim()}" saved`);
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The environment could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`/api/admin/environments/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`Environment "${target.label}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The environment could not be deleted");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="environments">
      <AdminSectionHeader
        icon={Layers}
        title="Environments"
        description="The labels datasources are filed under, with a colour and an order. Relabel or recolour the built-in ones, declare more; production keeps its own rules and stays."
        testId="environments-header"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => load()}
              disabled={!environments && !error}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Refresh
            </Button>
            <Button size="sm" className="h-8 text-xs gap-2" onClick={startNew}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New environment
            </Button>
          </>
        }
      />

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="environments-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!environments && !error ? (
        <div className="space-y-2" data-testid="environments-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : environments ? (
        <div className="border border-hairline rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Environment</TableHead>
                <TableHead className="text-xs">Label</TableHead>
                <TableHead className="text-xs">Order</TableHead>
                <TableHead className="text-xs text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((env) => (
                <TableRow key={env.id} data-testid={`environment-${env.id}`}>
                  <TableCell className="text-xs">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: env.color }} />
                      <span className="font-mono text-fg-primary">{env.id}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-fg-secondary">{env.label || "—"}</TableCell>
                  <TableCell className="text-xs font-mono text-fg-muted">{env.order}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Badge variant="secondary" className="text-[10px] mr-2">
                      {env.source === "builtin" ? "built-in" : env.source === "config" ? "seed file" : "declared"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => startEdit(env)}
                      aria-label={`Edit ${env.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </Button>
                    {env.source === "store" && env.id !== "production" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-status-danger"
                        onClick={() => setPendingDelete(env)}
                        aria-label={`Delete ${env.id}`}
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
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="environment-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <Layers strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">
                  {editing ? `Edit ${editing.id}` : "New environment"}
                </SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                The label is what listings show; the order is where it sorts, lowest first. The id is fixed once
                declared.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="environment-label" className="text-xs text-fg-tertiary">
                  Label
                </Label>
                <Input
                  id="environment-label"
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="QA"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {!editing && draft.label && (
                  <p className="text-[11px] font-mono text-fg-muted">
                    id: {slugifyEnvironmentId(draft.id || draft.label) || "—"}
                  </p>
                )}
              </div>
              {!editing && (
                <div className="space-y-1.5">
                  <Label htmlFor="environment-id" className="text-xs text-fg-tertiary">
                    Id (optional; from the label when blank)
                  </Label>
                  <Input
                    id="environment-id"
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="environment-color" className="text-xs text-fg-tertiary">
                    Colour
                  </Label>
                  <Input
                    id="environment-color"
                    type="color"
                    value={draft.color}
                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                    className="h-8 w-16 p-1 bg-panel border-hairline-strong"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="environment-order" className="text-xs text-fg-tertiary">
                    Order
                  </Label>
                  <Input
                    id="environment-order"
                    inputMode="numeric"
                    value={draft.order}
                    onChange={(e) => setDraft({ ...draft, order: e.target.value })}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving}>
              Save environment
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this environment?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.label}&rdquo; is removed from the list; a datasource still filed under it keeps the
              id and is listed under its own name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete environment</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
