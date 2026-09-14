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
import { Bot, Copy, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { ServiceTokenView } from "@/lib/service-tokens/types";

/**
 * Service tokens (docs/CONTEXT.md §4.10): the identities bots present to the execution
 * API. A token is created here with a role, optional groups and datasources, and whether
 * everything it sends must be reviewed; its secret is shown once, in this page, and never
 * again. Revoking keeps the row - the audit trail still names `svc:<name>` - and stops the
 * secret at once.
 */
interface Draft {
  name: string;
  role: "user" | "admin";
  groups: string;
  datasources: string;
  requireApproval: boolean;
}

const EMPTY: Draft = { name: "", role: "user", groups: "", datasources: "", requireApproval: true };

/** Comma-separated names as the API's list. */
export function listOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

async function fetchTokens(): Promise<ServiceTokenView[]> {
  const res = await appFetch("/api/admin/service-tokens");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { tokens: ServiceTokenView[] }).tokens;
}

export function ServiceTokensTab() {
  const [tokens, setTokens] = useState<ServiceTokenView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ServiceTokenView | null>(null);

  const load = useCallback(
    () =>
      fetchTokens()
        .then((list) => {
          setTokens(list);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Service tokens could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!draft.name.trim()) {
      toast.error("Give the token a name.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch("/api/admin/service-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          role: draft.role,
          groups: listOf(draft.groups),
          datasources: listOf(draft.datasources),
          requireApproval: draft.requireApproval,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; secret?: string };
      if (!res.ok || !body.secret) throw new Error(body.error ?? `The server refused the token (${res.status})`);
      setIssued({ name: draft.name.trim(), secret: body.secret });
      setOpen(false);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The token could not be created");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    try {
      const res = await appFetch(`/api/admin/service-tokens/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the revocation (${res.status})`);
      toast.success(`Service token "${target.name}" revoked`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The token could not be revoked");
    } finally {
      setPendingRevoke(null);
    }
  };

  const copySecret = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      toast.success("Secret copied");
    } catch {
      toast.error("Could not copy; select the secret and copy it by hand");
    }
  };

  return (
    <div className="space-y-4" data-testid="service-tokens">
      <AdminSectionHeader
        icon={Bot}
        title="Service tokens"
        description="The identity a bot presents to POST /api/v1/executions. A token has a role and groups like a person, may be limited to some datasources, and can be made to queue everything for review."
        testId="service-tokens-header"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => load()}
              disabled={!tokens && !error}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Refresh
            </Button>
            <Button size="sm" className="h-8 text-xs gap-2" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New token
            </Button>
          </>
        }
      />

      {issued && (
        <output
          className="block rounded-lg border border-warning-tint/30 bg-warning-tint/5 p-4 text-xs space-y-2"
          data-testid="service-token-secret"
        >
          <p className="text-fg-secondary">
            The secret of <strong>{issued.name}</strong>. Copy it now: it is not stored and cannot be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-[11px] break-all bg-panel border border-hairline rounded px-2 py-1 flex-1">
              {issued.secret}
            </code>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={copySecret}>
              <Copy className="h-3 w-3" /> Copy
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </output>
      )}

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="service-tokens-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!tokens && !error ? (
        <div className="space-y-2" data-testid="service-tokens-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : tokens && tokens.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="service-tokens-empty">
          No service token yet. A bot needs one to call the execution API.
        </p>
      ) : tokens ? (
        <div className="border border-hairline rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs">Secret</TableHead>
                <TableHead className="text-xs">Access</TableHead>
                <TableHead className="text-xs">Review</TableHead>
                <TableHead className="text-xs">Last used</TableHead>
                <TableHead className="text-xs text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id} data-testid={`service-token-${token.id}`}>
                  <TableCell className="text-xs">
                    <div className="font-medium text-fg-primary">{token.name}</div>
                    <div className="font-mono text-[10px] text-fg-muted">svc:{token.name}</div>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-fg-secondary">{token.prefix}…</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="text-[10px]">
                      {token.role}
                    </Badge>
                    {token.groups?.map((g) => (
                      <Badge key={g} variant="outline" className="ml-1 text-[10px]">
                        {g}
                      </Badge>
                    ))}
                    {token.datasources && token.datasources.length > 0 && (
                      <span className="ml-2 font-mono text-[10px] text-fg-muted">{token.datasources.join(", ")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-fg-muted">
                    {token.requireApproval ? "every request" : "writes that need it"}
                  </TableCell>
                  <TableCell className="text-xs text-fg-muted whitespace-nowrap">
                    {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "never"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {token.revokedAt ? (
                      <Badge variant="secondary" className="text-[10px]" title={`Revoked by ${token.revokedBy}`}>
                        revoked
                      </Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-status-danger"
                        onClick={() => setPendingRevoke(token)}
                        aria-label={`Revoke ${token.name}`}
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
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="service-token-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <Bot strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">New service token</SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">
                The secret is generated by the server and shown once after you create the token.
              </SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="token-name" className="text-xs text-fg-tertiary">
                  Name
                </Label>
                <Input
                  id="token-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="slack-bot"
                  className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                />
                <p className="text-[11px] text-fg-muted">
                  Lowercase letters, digits and dashes. The audit actor is svc:&lt;name&gt;.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token-role" className="text-xs text-fg-tertiary">
                  Role
                </Label>
                <select
                  id="token-role"
                  value={draft.role}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value as Draft["role"] })}
                  className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs text-fg-secondary"
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token-groups" className="text-xs text-fg-tertiary">
                  Groups (comma-separated, optional)
                </Label>
                <Input
                  id="token-groups"
                  value={draft.groups}
                  onChange={(e) => setDraft({ ...draft, groups: e.target.value })}
                  placeholder="sre, data-platform"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token-datasources" className="text-xs text-fg-tertiary">
                  Datasources (comma-separated ids, optional; empty means any its role allows)
                </Label>
                <Input
                  id="token-datasources"
                  value={draft.datasources}
                  onChange={(e) => setDraft({ ...draft, datasources: e.target.value })}
                  placeholder="prod-orders, prod-billing"
                  className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
              <label className="flex items-start gap-2 text-xs text-fg-secondary">
                <input
                  type="checkbox"
                  checked={draft.requireApproval}
                  onChange={(e) => setDraft({ ...draft, requireApproval: e.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  Every request waits for a reviewer, reads included. Off, only writes on datasources that require
                  approval wait.
                </span>
              </label>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={create} disabled={saving}>
              Create token
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingRevoke !== null} onOpenChange={(next) => !next && setPendingRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke service token?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingRevoke?.name}&rdquo; stops working at once. Requests it already queued still run when
              approved only if the token is live, so this also stops those.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={revoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
