"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { ListChecks, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { RunbookParam } from "@/lib/seed/types";

/**
 * The runbooks of the datasource the operations page has selected (docs/CONTEXT.md
 * §4.20): declare one from a name, a statement with `{{placeholders}}` and the parameters
 * it asks for; delete one. A seed-file runbook is read-only here.
 */
export interface RunbookView {
  id: string;
  name: string;
  description?: string;
  datasource: string;
  sql: string;
  params?: RunbookParam[];
  source: "config" | "store";
}

interface Draft {
  name: string;
  description: string;
  sql: string;
  params: string;
}

const EMPTY: Draft = { name: "", description: "", sql: "", params: "" };
const TYPES = new Set(["string", "number", "boolean"]);

export function slugifyRunbookId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * One parameter per line as `name:type[:label][?]` - `order_id:number:Order id`,
 * `note:string?` for an optional one. What does not parse is reported by line.
 */
export function parseParams(text: string): { params: RunbookParam[]; error?: string } {
  const params: RunbookParam[] = [];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const optional = line.endsWith("?");
    const body = optional ? line.slice(0, -1) : line;
    const first = body.indexOf(":");
    const second = first === -1 ? -1 : body.indexOf(":", first + 1);
    const name = first === -1 ? "" : body.slice(0, first).trim();
    const type = first === -1 ? "" : body.slice(first + 1, second === -1 ? undefined : second).trim();
    if (!name || !type || !TYPES.has(type)) return { params: [], error: `Cannot read parameter "${line}"` };
    const label = second === -1 ? "" : body.slice(second + 1).trim();
    params.push({
      name,
      type: type as RunbookParam["type"],
      ...(label ? { label } : {}),
      ...(optional ? { required: false } : {}),
    });
  }
  return { params };
}

export function RunbooksPanel({ datasourceId, datasourceName }: { datasourceId: string; datasourceName: string }) {
  const [runbooks, setRunbooks] = useState<RunbookView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RunbookView | null>(null);

  const load = useCallback(
    () =>
      appFetch("/api/admin/runbooks")
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { runbooks?: RunbookView[]; error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setRunbooks((body.runbooks ?? []).filter((r) => r.datasource === datasourceId));
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Runbooks could not be loaded")),
    [datasourceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const id = slugifyRunbookId(draft.name);
    const parsed = parseParams(draft.params);
    if (parsed.error) {
      toast.error(parsed.error);
      return;
    }
    if (!id || !draft.sql.trim()) {
      toast.error("A name and a statement are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch("/api/admin/runbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: draft.name.trim(),
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
          datasource: datasourceId,
          sql: draft.sql.trim(),
          ...(parsed.params.length > 0 ? { params: parsed.params } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the runbook (${res.status})`);
      toast.success(`Runbook "${draft.name.trim()}" declared`);
      setOpen(false);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The runbook could not be declared");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`/api/admin/runbooks/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`Runbook "${target.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The runbook could not be deleted");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="rounded-xl border border-hairline bg-panel p-4 space-y-3" data-testid="runbooks-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-bold text-fg-secondary">Runbooks</h3>
          <span className="text-xs text-fg-muted">on {datasourceName}</span>
        </div>
        <Button size="sm" className="h-8 text-xs gap-2" onClick={() => setOpen(true)}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New runbook
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-status-danger" data-testid="runbooks-panel-error">
          {error}
        </p>
      ) : runbooks === null ? (
        <p className="text-xs text-fg-muted" data-testid="runbooks-panel-loading">
          Loading…
        </p>
      ) : runbooks.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="runbooks-panel-empty">
          No runbook on this datasource yet.
        </p>
      ) : (
        <ul className="divide-y divide-hairline">
          {runbooks.map((runbook) => (
            <li
              key={runbook.id}
              className="flex items-start justify-between gap-3 py-2"
              data-testid={`runbook-row-${runbook.id}`}
            >
              <div className="min-w-0">
                <div className="text-xs font-medium text-fg-primary">{runbook.name}</div>
                <div className="font-mono text-[10px] text-fg-muted truncate">{runbook.sql}</div>
                {runbook.params && runbook.params.length > 0 && (
                  <div className="text-[10px] text-fg-muted">
                    {runbook.params.map((p) => `${p.name}:${p.type}${p.required === false ? "?" : ""}`).join(", ")}
                  </div>
                )}
              </div>
              {runbook.source === "config" ? (
                <Badge
                  variant="secondary"
                  className="text-[10px] shrink-0"
                  title="Declared in the seed file; edit it there"
                >
                  seed file
                </Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-status-danger shrink-0"
                  onClick={() => setPendingDelete(runbook)}
                  aria-label={`Delete ${runbook.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Sheet open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="runbook-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <ListChecks strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">
                  New runbook on {datasourceName}
                </SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                Name the values the statement asks for as {"{{name}}"}; they are bound by the driver, never written into
                the statement. Whoever runs it needs the same rights as by hand.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="runbook-name" className="text-xs text-fg-tertiary">
                  Name
                </Label>
                <Input
                  id="runbook-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Orders of a customer"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {draft.name && (
                  <p className="text-[11px] font-mono text-fg-muted">id: {slugifyRunbookId(draft.name) || "—"}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="runbook-description" className="text-xs text-fg-tertiary">
                  Description (optional)
                </Label>
                <Input
                  id="runbook-description"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="runbook-sql" className="text-xs text-fg-tertiary">
                  Statement
                </Label>
                <Textarea
                  id="runbook-sql"
                  value={draft.sql}
                  onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
                  placeholder={"SELECT * FROM orders WHERE customer_id = {{customer_id}} LIMIT {{limit}}"}
                  rows={6}
                  className="text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="runbook-params" className="text-xs text-fg-tertiary">
                  Parameters (one per line: name:type[:label], a trailing ? for optional)
                </Label>
                <Textarea
                  id="runbook-params"
                  value={draft.params}
                  onChange={(e) => setDraft({ ...draft, params: e.target.value })}
                  placeholder={"customer_id:number:Customer id\nlimit:number?"}
                  rows={4}
                  className="text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={create} disabled={saving}>
              Declare runbook
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this runbook?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.name}&rdquo; disappears from the studio at once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete runbook</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
