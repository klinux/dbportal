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
import { CHANNEL_KINDS, type ChannelKind } from "@/lib/seed/types";
import { BellRing, Plus, RefreshCw, Send, Trash2, TriangleAlert } from "lucide-react";
import { SlackChannelPicker } from "@/components/alerts/SlackChannelPicker";
import { toast } from "sonner";

/**
 * Notification channels (docs/CONTEXT.md §4.29): where alerts fire to, declared once. A
 * Slack channel the bot posts to (picked by name), a generic signed webhook, a Grafana
 * OnCall formatted webhook, a Rootly alert source. Each can be sent a test message before
 * an alert needs it. Two scopes: `admin` (Security → Channels: every channel with its
 * target, delete any stored one) and `user` (beside the alerts: id, name, kind and who
 * declared each; delete one's own; a webhook host from the operator's allowed list).
 */
export interface ChannelView {
  id: string;
  name: string;
  kind: ChannelKind;
  target?: string;
  source?: "config" | "store";
  createdBy?: string;
}

export type ChannelsScope = "admin" | "user";

export const KIND_LABELS: Record<ChannelKind, string> = {
  slack: "Slack channel",
  webhook: "Webhook (signed JSON)",
  oncall: "Grafana OnCall",
  rootly: "Rootly",
};

const TARGET_HINT: Record<ChannelKind, string> = {
  slack: "Pick the channel by name, or type its id (C0123…); the bot must be a member.",
  webhook:
    "An https URL. The message is POSTed as JSON, signed with CALLBACK_SIGNING_SECRET when set. Unless you administer, the host must be one the operator allowed (CALLBACK_ALLOWED_HOSTS).",
  oncall: "The URL of a Grafana OnCall 'Formatted webhook' integration.",
  rootly: "The URL Rootly gives for a generic webhook alert source.",
};

interface Draft {
  id: string;
  name: string;
  kind: ChannelKind;
  target: string;
}

const EMPTY: Draft = { id: "", name: "", kind: "slack", target: "" };

export function slugifyChannelId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function fetchChannels(base: string): Promise<ChannelView[]> {
  const res = await appFetch(base);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { channels: ChannelView[] }).channels;
}

export function ChannelsTab({ scope = "admin", username }: { scope?: ChannelsScope; username?: string }) {
  const base = scope === "admin" ? "/api/admin/channels" : "/api/channels";
  const mayDelete = (channel: ChannelView) =>
    scope === "admin" ? channel.source === "store" : channel.createdBy !== undefined && channel.createdBy === username;
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChannelView | null>(null);

  const load = useCallback(
    () =>
      fetchChannels(base)
        .then((list) => {
          setChannels(list);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Channels could not be loaded")),
    [base],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const id = slugifyChannelId(draft.id || draft.name);
    if (!id || !draft.name.trim() || !draft.target.trim()) {
      toast.error("A name, an id and a target are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: draft.name.trim(), kind: draft.kind, target: draft.target.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the channel (${res.status})`);
      toast.success(`Channel "${draft.name.trim()}" saved`);
      setOpen(false);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The channel could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (channel: ChannelView) => {
    setTesting(channel.id);
    try {
      const res = await appFetch(`${base}/${encodeURIComponent(channel.id)}/test`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { delivered?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the test (${res.status})`);
      if (body.delivered) toast.success(`Test message delivered to "${channel.name}"`);
      else toast.error(`"${channel.name}" did not take the test message; see the server log`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The test could not be sent");
    } finally {
      setTesting(null);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`${base}/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`Channel "${target.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The channel could not be deleted");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="channels">
      <AdminSectionHeader
        icon={BellRing}
        title="Notification channels"
        description={
          scope === "admin"
            ? "Where alerts fire to: a Slack channel, a signed webhook, Grafana OnCall, Rootly. Declared once here, picked by name in an alert."
            : "Where your alerts fire to: a Slack channel picked by name, or a webhook on a host the operator allowed. Anyone may pick any channel; you delete the ones you declared."
        }
        testId="channels-header"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => load()}
              disabled={!channels && !error}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Refresh
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => {
                setDraft(EMPTY);
                setOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New channel
            </Button>
          </>
        }
      />

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="channels-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!channels && !error ? (
        <div className="space-y-2" data-testid="channels-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : channels ? (
        channels.length === 0 ? (
          <p className="text-xs text-fg-muted" data-testid="channels-empty">
            No channel declared yet. An alert cannot fire anywhere until one is.
          </p>
        ) : (
          <div className="border border-hairline rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Channel</TableHead>
                  <TableHead className="text-xs">Kind</TableHead>
                  <TableHead className="text-xs">{scope === "admin" ? "Target" : "Declared by"}</TableHead>
                  <TableHead className="text-xs text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((channel) => (
                  <TableRow key={channel.id} data-testid={`channel-${channel.id}`}>
                    <TableCell className="text-xs">
                      <div className="text-fg-primary">{channel.name}</div>
                      <div className="font-mono text-[11px] text-fg-muted">{channel.id}</div>
                    </TableCell>
                    <TableCell className="text-xs text-fg-secondary">{KIND_LABELS[channel.kind]}</TableCell>
                    <TableCell
                      className="text-xs font-mono text-fg-muted max-w-[280px] truncate"
                      title={channel.target}
                    >
                      {scope === "admin" ? channel.target : (channel.createdBy ?? "seed file")}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {scope === "admin" && (
                        <Badge variant="secondary" className="text-[10px] mr-2">
                          {channel.source === "config" ? "seed file" : "declared"}
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => sendTest(channel)}
                        disabled={testing !== null}
                        aria-label={`Send a test to ${channel.id}`}
                      >
                        <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Button>
                      {mayDelete(channel) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-status-danger"
                          onClick={() => setPendingDelete(channel)}
                          aria-label={`Delete ${channel.id}`}
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
        )
      ) : null}

      <Sheet open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="channel-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <BellRing strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">New channel</SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                The id is what an alert names; it is fixed once declared. Send a test from the list once saved.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="channel-name" className="text-xs text-fg-tertiary">
                  Name
                </Label>
                <Input
                  id="channel-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Ops on-call"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {draft.name && (
                  <p className="text-[11px] font-mono text-fg-muted">
                    id: {slugifyChannelId(draft.id || draft.name) || "—"}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="channel-id" className="text-xs text-fg-tertiary">
                  Id (optional; from the name when blank)
                </Label>
                <Input
                  id="channel-id"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="channel-kind" className="text-xs text-fg-tertiary">
                  Kind
                </Label>
                <select
                  id="channel-kind"
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as ChannelKind })}
                  className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs"
                >
                  {CHANNEL_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="channel-target" className="text-xs text-fg-tertiary">
                  {draft.kind === "slack" ? "Channel id" : "URL"}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="channel-target"
                    value={draft.target}
                    onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                    placeholder={draft.kind === "slack" ? "C0123ABCD" : "https://…"}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                  {draft.kind === "slack" && (
                    <SlackChannelPicker
                      onPick={(channel) =>
                        setDraft((d) => ({ ...d, target: channel.id, name: d.name || `#${channel.name}` }))
                      }
                    />
                  )}
                </div>
                <p className="text-[11px] text-fg-muted">{TARGET_HINT[draft.kind]}</p>
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving}>
              Save channel
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this channel?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.name}&rdquo; stops being offered to alerts. One that an alert still names cannot be
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete channel</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
