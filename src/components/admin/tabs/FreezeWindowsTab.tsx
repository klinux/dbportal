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
import { Plus, RefreshCw, Snowflake, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

/**
 * Freeze windows (docs/CONTEXT.md §4.17): the periods in which no write runs on the
 * datasources named - or on every datasource. Declared here with a reason and two
 * instants, ended early by deleting; a seed-file window is read-only here.
 */
export interface FreezeWindowView {
  id: string;
  reason: string;
  from: string;
  until: string;
  datasources?: string[];
  source: "config" | "store";
  createdBy?: string;
}

interface Draft {
  id: string;
  reason: string;
  from: string;
  until: string;
  datasources: string;
}

const EMPTY: Draft = { id: "", reason: "", from: "", until: "", datasources: "" };

export function slugifyFreezeId(reason: string): string {
  return reason
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** A `datetime-local` value (the browser's local time) as the instant the API wants. */
export function toInstant(local: string): string | null {
  const ms = Date.parse(local);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function stateOf(window: { from: string; until: string }, now: number): "active" | "upcoming" | "past" {
  if (now < Date.parse(window.from)) return "upcoming";
  if (now >= Date.parse(window.until)) return "past";
  return "active";
}

async function fetchWindows(): Promise<FreezeWindowView[]> {
  const res = await appFetch("/api/admin/freezes");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { windows: FreezeWindowView[] }).windows;
}

export function FreezeWindowsTab() {
  const [windows, setWindows] = useState<FreezeWindowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FreezeWindowView | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    () =>
      fetchWindows()
        .then((list) => {
          setWindows(list);
          setError(null);
          setNow(Date.now());
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Freeze windows could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const id = slugifyFreezeId(draft.id || draft.reason);
    const from = toInstant(draft.from);
    const until = toInstant(draft.until);
    if (!id || !draft.reason.trim() || !from || !until) {
      toast.error("A reason, a start and an end are required.");
      return;
    }
    setSaving(true);
    try {
      const datasources = [
        ...new Set(
          draft.datasources
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      const res = await appFetch("/api/admin/freezes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          reason: draft.reason.trim(),
          from,
          until,
          ...(datasources.length > 0 ? { datasources } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the window (${res.status})`);
      toast.success(`Freeze window "${draft.reason.trim()}" declared`);
      setOpen(false);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The window could not be declared");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`/api/admin/freezes/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`Freeze window "${target.reason}" ended`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The window could not be ended");
    } finally {
      setPendingDelete(null);
    }
  };

  const fmt = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="space-y-4" data-testid="freeze-windows">
      <AdminSectionHeader
        icon={Snowflake}
        title="Freeze windows"
        description="Between the two instants no statement that writes runs on the datasources named, or on any datasource when none is named, whoever asks. End one early by deleting it."
        testId="freeze-windows-header"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => load()}
              disabled={!windows && !error}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Refresh
            </Button>
            <Button size="sm" className="h-8 text-xs gap-2" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New window
            </Button>
          </>
        }
      />

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="freeze-windows-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!windows && !error ? (
        <div className="space-y-2" data-testid="freeze-windows-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : windows && windows.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="freeze-windows-empty">
          No freeze window. Writes run whenever the datasource's own rules allow.
        </p>
      ) : windows ? (
        <div className="border border-hairline rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Reason</TableHead>
                <TableHead className="text-xs">From</TableHead>
                <TableHead className="text-xs">Until</TableHead>
                <TableHead className="text-xs">Datasources</TableHead>
                <TableHead className="text-xs">State</TableHead>
                <TableHead className="text-xs text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {windows.map((window) => {
                const state = stateOf(window, now);
                return (
                  <TableRow key={window.id} data-testid={`freeze-${window.id}`}>
                    <TableCell className="text-xs">
                      <div className="font-medium text-fg-primary">{window.reason}</div>
                      <div className="font-mono text-[10px] text-fg-muted">{window.id}</div>
                    </TableCell>
                    <TableCell className="text-xs text-fg-secondary whitespace-nowrap">{fmt(window.from)}</TableCell>
                    <TableCell className="text-xs text-fg-secondary whitespace-nowrap">{fmt(window.until)}</TableCell>
                    <TableCell className="text-xs font-mono text-fg-muted">
                      {window.datasources && window.datasources.length > 0
                        ? window.datasources.join(", ")
                        : "every datasource"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge
                        variant={state === "active" ? "secondary" : "outline"}
                        className={state === "active" ? "text-[10px] text-status-danger" : "text-[10px]"}
                      >
                        {state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {window.source === "config" ? (
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
                          onClick={() => setPendingDelete(window)}
                          aria-label={`End ${window.reason}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Sheet open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="freeze-window-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <Snowflake strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">New freeze window</SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                Times are your local time; the server keeps the instants. Leave the datasources blank to freeze every
                one.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="freeze-reason" className="text-xs text-fg-tertiary">
                  Reason
                </Label>
                <Input
                  id="freeze-reason"
                  value={draft.reason}
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  placeholder="Release 42 deploy"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {draft.reason && (
                  <p className="text-[11px] font-mono text-fg-muted">id: {slugifyFreezeId(draft.reason) || "—"}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="freeze-from" className="text-xs text-fg-tertiary">
                    From
                  </Label>
                  <Input
                    id="freeze-from"
                    type="datetime-local"
                    value={draft.from}
                    onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                    className="h-8 text-xs bg-panel border-hairline-strong"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="freeze-until" className="text-xs text-fg-tertiary">
                    Until
                  </Label>
                  <Input
                    id="freeze-until"
                    type="datetime-local"
                    value={draft.until}
                    onChange={(e) => setDraft({ ...draft, until: e.target.value })}
                    className="h-8 text-xs bg-panel border-hairline-strong"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="freeze-datasources" className="text-xs text-fg-tertiary">
                  Datasources (comma-separated ids; blank means every datasource)
                </Label>
                <Input
                  id="freeze-datasources"
                  value={draft.datasources}
                  onChange={(e) => setDraft({ ...draft, datasources: e.target.value })}
                  placeholder="prod-orders, prod-billing"
                  className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={create} disabled={saving}>
              Declare window
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this freeze window?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.reason}&rdquo; is removed and writes run again as the datasources&apos; own rules
              allow.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>End window</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
