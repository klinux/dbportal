"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { useAllConnections } from "@/hooks/use-all-connections";
import { useChannels } from "@/hooks/use-channels";
import { ALERT_OPS, COMPARING_OPS, type AlertOp, type AlertRecord, type AlertStatus } from "@/lib/alerts/types";
import { BellRing, Pencil, Play, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

/**
 * The alerts panel (docs/CONTEXT.md §4.29): the alerts this person keeps - every one, for
 * an administrator - with the state each landed in, the editor that declares one, a run
 * on demand, and deletion. The datasources offered are the ones this session may open;
 * the channels, the ones an administrator declared.
 */
export const OP_LABELS: Record<AlertOp, string> = {
  ">": "is greater than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
  "==": "equals",
  "!=": "differs from",
  changed: "changed since the last run",
  any_rows: "any row is returned",
  no_rows: "no row is returned",
};

const STATUS_LABEL: Record<AlertStatus, string> = {
  unknown: "not run yet",
  ok: "ok",
  firing: "firing",
  error: "error",
};
const STATUS_CLASS: Record<AlertStatus, string> = {
  unknown: "bg-fill text-fg-muted",
  ok: "bg-status-success/15 text-status-success",
  firing: "bg-status-danger/15 text-status-danger",
  error: "bg-status-warning/15 text-status-warning",
};

interface Draft {
  id: string;
  name: string;
  datasource: string;
  sql: string;
  column: string;
  op: AlertOp;
  value: string;
  everyMinutes: string;
  cooldownMinutes: string;
  channels: string[];
  enabled: boolean;
}

const EMPTY: Draft = {
  id: "",
  name: "",
  datasource: "",
  sql: "",
  column: "",
  op: ">",
  value: "",
  everyMinutes: "5",
  cooldownMinutes: "60",
  channels: [],
  enabled: true,
};

export function slugifyAlertId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The body the server validates, from the form; a number where the text is one. */
export function draftToPayload(draft: Draft, editing: boolean) {
  const value = draft.value.trim();
  const numeric = value !== "" && !Number.isNaN(Number(value));
  return {
    id: editing ? draft.id : slugifyAlertId(draft.id || draft.name),
    name: draft.name.trim(),
    datasource: draft.datasource,
    sql: draft.sql,
    ...(draft.column.trim() ? { column: draft.column.trim() } : {}),
    op: draft.op,
    ...(COMPARING_OPS.includes(draft.op) ? { value: numeric ? Number(value) : value } : {}),
    everyMinutes: Number(draft.everyMinutes),
    cooldownMinutes: Number(draft.cooldownMinutes),
    channels: draft.channels,
    enabled: draft.enabled,
  };
}

function ago(iso: string | undefined): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

async function fetchAlerts(): Promise<AlertRecord[]> {
  const res = await appFetch("/api/alerts");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { alerts: AlertRecord[] }).alerts;
}

export function AlertsPanel() {
  const { connections } = useAllConnections();
  const channels = useChannels();
  const [alerts, setAlerts] = useState<AlertRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRecord | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AlertRecord | null>(null);

  const load = useCallback(
    () =>
      fetchAlerts()
        .then((list) => {
          setAlerts(list.sort((a, b) => a.name.localeCompare(b.name)));
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Alerts could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = () => {
    setEditing(null);
    setDraft({ ...EMPTY, datasource: connections[0]?.seedId ?? "" });
    setOpen(true);
  };

  const startEdit = (alert: AlertRecord) => {
    setEditing(alert);
    setDraft({
      id: alert.id,
      name: alert.name,
      datasource: alert.datasource,
      sql: alert.sql,
      column: alert.column ?? "",
      op: alert.op,
      value: alert.value === undefined ? "" : String(alert.value),
      everyMinutes: String(alert.everyMinutes),
      cooldownMinutes: String(alert.cooldownMinutes),
      channels: [...alert.channels],
      enabled: alert.enabled,
    });
    setOpen(true);
  };

  const save = async () => {
    const payload = draftToPayload(draft, editing !== null);
    if (!payload.id || !payload.name || !payload.datasource || !payload.sql.trim()) {
      toast.error("A name, a datasource and a statement are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch(editing ? `/api/alerts/${encodeURIComponent(editing.id)}` : "/api/alerts", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the alert (${res.status})`);
      toast.success(`Alert "${payload.name}" saved`);
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The alert could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (alert: AlertRecord) => {
    setRunning(alert.id);
    try {
      const res = await appFetch(`/api/alerts/${encodeURIComponent(alert.id)}/run`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { state?: AlertRecord["state"]; error?: string };
      if (!res.ok || !body.state) throw new Error(body.error ?? `The server refused the run (${res.status})`);
      const state = body.state;
      if (state.status === "error") toast.error(`"${alert.name}" failed: ${state.lastError ?? "error"}`);
      else
        toast.success(
          `"${alert.name}" ran: ${STATUS_LABEL[state.status]}${state.lastValue !== undefined ? ` (value ${state.lastValue})` : ""}`,
        );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The alert could not be run");
    } finally {
      setRunning(null);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`/api/alerts/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`Alert "${target.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The alert could not be deleted");
    } finally {
      setPendingDelete(null);
    }
  };

  const toggleChannel = (id: string) =>
    setDraft((d) => ({
      ...d,
      channels: d.channels.includes(id) ? d.channels.filter((c) => c !== id) : [...d.channels, id],
    }));

  const datasourceName = (id: string) => connections.find((c) => c.seedId === id)?.name ?? id;

  return (
    <div className="space-y-4" data-testid="alerts">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs gap-2"
          onClick={() => load()}
          disabled={!alerts && !error}
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          Refresh
        </Button>
        <Button size="sm" className="h-8 text-xs gap-2" onClick={startNew}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New alert
        </Button>
      </div>

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="alerts-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!alerts && !error ? (
        <div className="space-y-2" data-testid="alerts-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : alerts ? (
        alerts.length === 0 ? (
          <p className="text-xs text-fg-muted" data-testid="alerts-empty">
            No alert yet. Declare one: a read, a schedule, a condition, and where it fires to.
          </p>
        ) : (
          <div className="border border-hairline rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Alert</TableHead>
                  <TableHead className="text-xs">Datasource</TableHead>
                  <TableHead className="text-xs">Condition</TableHead>
                  <TableHead className="text-xs">State</TableHead>
                  <TableHead className="text-xs">Last run</TableHead>
                  <TableHead className="text-xs text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((alert) => (
                  <TableRow
                    key={alert.id}
                    data-testid={`alert-${alert.id}`}
                    className={alert.enabled ? "" : "opacity-60"}
                  >
                    <TableCell className="text-xs">
                      <div className="text-fg-primary">{alert.name}</div>
                      <div className="font-mono text-[11px] text-fg-muted">
                        {alert.id} · every {alert.everyMinutes} min · {alert.owner.username}
                        {alert.enabled ? "" : " · paused"}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-fg-secondary">{datasourceName(alert.datasource)}</TableCell>
                    <TableCell className="text-xs text-fg-secondary">
                      {alert.column ?? "value"} {OP_LABELS[alert.op]}
                      {COMPARING_OPS.includes(alert.op) ? ` ${alert.value}` : ""}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span
                        className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[alert.state.status]}`}
                        data-testid={`alert-${alert.id}-status`}
                      >
                        {STATUS_LABEL[alert.state.status]}
                        {alert.state.status === "error" && alert.state.lastError ? `: ${alert.state.lastError}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-fg-muted">
                      {ago(alert.state.lastRunAt)}
                      {alert.state.lastValue !== undefined ? ` · ${alert.state.lastValue}` : ""}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => runNow(alert)}
                        disabled={running !== null}
                        aria-label={`Run ${alert.id} now`}
                      >
                        <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => startEdit(alert)}
                        aria-label={`Edit ${alert.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-status-danger"
                        onClick={() => setPendingDelete(alert)}
                        aria-label={`Delete ${alert.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}

      <Sheet open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="alert-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <BellRing strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">
                  {editing ? `Edit ${editing.id}` : "New alert"}
                </SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                The read runs as you, on the schedule, bounded like any statement; the value is the first row&apos;s
                column. It fires when the condition holds, again after the cooldown while it keeps holding, and resolves
                when it stops.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="alert-name" className="text-xs text-fg-tertiary">
                  Name
                </Label>
                <Input
                  id="alert-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Orders older than an hour"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {!editing && draft.name && (
                  <p className="text-[11px] font-mono text-fg-muted">
                    id: {slugifyAlertId(draft.id || draft.name) || "—"}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-datasource" className="text-xs text-fg-tertiary">
                  Datasource
                </Label>
                <select
                  id="alert-datasource"
                  value={draft.datasource}
                  onChange={(e) => setDraft({ ...draft, datasource: e.target.value })}
                  className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs"
                >
                  <option value="">Select a datasource</option>
                  {connections
                    .filter((c) => c.seedId)
                    .map((c) => (
                      <option key={c.id} value={c.seedId}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-sql" className="text-xs text-fg-tertiary">
                  Statement (a read)
                </Label>
                <Textarea
                  id="alert-sql"
                  value={draft.sql}
                  onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
                  placeholder="SELECT count(*) AS stuck FROM orders WHERE status = 'pending' AND created_at < now() - interval '1 hour'"
                  className="min-h-[96px] text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="alert-column" className="text-xs text-fg-tertiary">
                    Column (first when blank)
                  </Label>
                  <Input
                    id="alert-column"
                    value={draft.column}
                    onChange={(e) => setDraft({ ...draft, column: e.target.value })}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-op" className="text-xs text-fg-tertiary">
                    Condition
                  </Label>
                  <select
                    id="alert-op"
                    value={draft.op}
                    onChange={(e) => setDraft({ ...draft, op: e.target.value as AlertOp })}
                    className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs"
                  >
                    {ALERT_OPS.map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-value" className="text-xs text-fg-tertiary">
                    Value
                  </Label>
                  <Input
                    id="alert-value"
                    value={draft.value}
                    onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                    disabled={!COMPARING_OPS.includes(draft.op)}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="alert-every" className="text-xs text-fg-tertiary">
                    Run every (minutes)
                  </Label>
                  <Input
                    id="alert-every"
                    inputMode="numeric"
                    value={draft.everyMinutes}
                    onChange={(e) => setDraft({ ...draft, everyMinutes: e.target.value })}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-cooldown" className="text-xs text-fg-tertiary">
                    Cooldown while firing (minutes)
                  </Label>
                  <Input
                    id="alert-cooldown"
                    inputMode="numeric"
                    value={draft.cooldownMinutes}
                    onChange={(e) => setDraft({ ...draft, cooldownMinutes: e.target.value })}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs text-fg-tertiary">Channels</p>
                {channels.length === 0 ? (
                  <p className="text-[11px] text-fg-muted" data-testid="alert-no-channels">
                    No channel declared yet; an administrator declares them under Security → Channels.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {channels.map((channel) => (
                      <label key={channel.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={draft.channels.includes(channel.id)}
                          onChange={() => toggleChannel(channel.id)}
                          aria-label={`Channel ${channel.id}`}
                        />
                        {channel.name}
                        <span className="text-[10px] text-fg-muted">({channel.kind})</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  aria-label="Enabled"
                />
                Enabled
              </label>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving}>
              Save alert
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this alert?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.name}&rdquo; stops running and is removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete alert</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
