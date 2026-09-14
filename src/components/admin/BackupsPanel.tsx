"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Archive, CloudUpload, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

/**
 * Backups of the datasource the operations page has selected (docs/CONTEXT.md §4.14): take
 * one now, see the files taken, and - outside production - restore one. Everything the
 * panel may offer comes from the server's answer: an unsupported engine, a missing tool or
 * a production datasource are stated, not guessed at here.
 */
export interface BackupsState {
  supported: boolean;
  tool: boolean;
  restoreAllowed: boolean;
  bucket: boolean;
  backups: { name: string; size: number; createdAt: string }[];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BackupsPanel({ datasourceId, datasourceName }: { datasourceId: string; datasourceName: string }) {
  const [state, setState] = useState<BackupsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);

  const load = useCallback(
    () =>
      appFetch(`/api/admin/backups?datasourceId=${encodeURIComponent(datasourceId)}`)
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as BackupsState & { error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setState(body);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Backups could not be loaded")),
    [datasourceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const backup = async () => {
    setBusy("backup");
    try {
      const res = await appFetch("/api/admin/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasourceId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        backup?: { name: string; object?: string };
      };
      if (!res.ok || !body.backup) throw new Error(body.error ?? `The backup failed (${res.status})`);
      toast.success(body.backup.object ? `Backup taken and copied to the bucket` : `Backup ${body.backup.name} taken`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The backup failed");
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!pendingRestore) return;
    const name = pendingRestore;
    setPendingRestore(null);
    setBusy("restore");
    try {
      const res = await appFetch("/api/admin/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasourceId, name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The restore failed (${res.status})`);
      toast.success(`"${datasourceName}" restored from ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The restore failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="backups-panel">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-bold text-fg-secondary">Backups</h3>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => load()} disabled={!state && !error}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs border-hairline-strong"
            onClick={backup}
            disabled={!state?.supported || !state.tool || busy !== null}
          >
            {busy === "backup" ? (
              <RefreshCw className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <Archive className="w-3 h-3 mr-1" />
            )}
            Back up now
          </Button>
        </div>
      </div>

      <div className="p-4 rounded-xl border border-hairline bg-fill-subtle space-y-3">
        {error ? (
          <output className="block text-xs text-status-danger" data-testid="backups-error">
            {error}
          </output>
        ) : !state ? (
          <p className="text-xs text-fg-muted" data-testid="backups-loading">
            Loading…
          </p>
        ) : !state.supported ? (
          <p className="text-xs text-fg-muted">Backups are offered for PostgreSQL datasources only.</p>
        ) : !state.tool ? (
          <p className="text-xs text-fg-muted">
            pg_dump is not installed on this server, so no backup can be taken here.
          </p>
        ) : (
          <>
            <p className="text-xs text-fg-muted leading-relaxed">
              A dump with pg_dump into the server&apos;s backup directory
              {state.bucket ? ", copied to the configured bucket" : ""}.
              {state.restoreAllowed
                ? " A restore replaces the database's objects with the file's; it is offered because this datasource is not production."
                : " Restore is not offered on a production datasource."}
            </p>
            {state.backups.length === 0 ? (
              <p className="text-xs text-fg-muted" data-testid="backups-empty">
                No backup taken yet.
              </p>
            ) : (
              <ul className="divide-y divide-hairline">
                {state.backups.map((file) => (
                  <li
                    key={file.name}
                    className="flex items-center justify-between py-2 text-xs"
                    data-testid={`backup-${file.name}`}
                  >
                    <span className="font-mono text-fg-secondary">
                      {file.name}
                      <span className="ml-2 text-fg-muted">{formatSize(file.size)}</span>
                    </span>
                    {state.restoreAllowed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={busy !== null}
                        onClick={() => setPendingRestore(file.name)}
                        aria-label={`Restore ${file.name}`}
                      >
                        <RotateCcw className="w-3 h-3 mr-1" /> Restore
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {state.bucket && (
              <p className="flex items-center gap-1 text-[11px] text-fg-muted">
                <CloudUpload className="h-3 w-3" /> Every backup is also copied to the bucket.
              </p>
            )}
          </>
        )}
      </div>

      <AlertDialog open={pendingRestore !== null} onOpenChange={(open) => !open && setPendingRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{datasourceName}&rdquo; is replaced by the contents of {pendingRestore}. Objects created since are
              dropped. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={restore}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
