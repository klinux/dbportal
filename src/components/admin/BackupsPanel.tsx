"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * a production datasource are stated, not guessed at here. A backup a worker still has
 * (§4.40) is polled until it settles, whether this page asked for it or found it on load.
 */
export interface BackupOutcome {
  jobId: string;
  action: "create" | "restore";
  status: string;
  backup?: { name: string; object?: string };
  error?: string;
}

export interface BackupsState {
  supported: boolean;
  tool: boolean;
  restoreAllowed: boolean;
  bucket: boolean;
  backups: { name: string; size: number; createdAt: string }[];
  job?: BackupOutcome | null;
}

export const BACKUP_POLL_MS = 2_000;

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
  const polling = useRef<string | null>(null);

  const load = useCallback(
    () =>
      appFetch(`/api/admin/backups?datasourceId=${encodeURIComponent(datasourceId)}`)
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as BackupsState & { error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setState(body);
          setError(null);
          return body;
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Backups could not be loaded");
          return null;
        }),
    [datasourceId],
  );

  /** The job's outcome once a worker settled it: the route's 202s are waited out. */
  const settled = async (outcome: BackupOutcome & { ok: boolean }): Promise<BackupOutcome & { ok: boolean }> => {
    let current = outcome;
    while (current.status === "queued" || current.status === "running") {
      await new Promise((r) => setTimeout(r, BACKUP_POLL_MS));
      const res = await appFetch(`/api/admin/backups/${encodeURIComponent(current.jobId)}`);
      const body = (await res.json().catch(() => ({}))) as BackupOutcome;
      current = { ...current, ...body, ok: res.ok };
      if (res.status !== 202 && !("status" in body)) break;
    }
    return current;
  };

  const report = (outcome: BackupOutcome & { ok: boolean }, restoredFrom?: string) => {
    if (!outcome.ok || outcome.status !== "done") {
      toast.error(outcome.error ?? `The ${outcome.action === "restore" ? "restore" : "backup"} failed`);
      return;
    }
    if (outcome.action === "restore") {
      toast.success(`"${datasourceName}" restored from ${restoredFrom ?? outcome.backup?.name ?? "the backup"}`);
      return;
    }
    toast.success(
      outcome.backup?.object ? `Backup taken and copied to the bucket` : `Backup ${outcome.backup?.name} taken`,
    );
  };

  /** A job found open on load - asked from another page, or one this page lost - is followed to its end. */
  const follow = useCallback(
    async (job: BackupOutcome) => {
      if (polling.current === job.jobId) return;
      polling.current = job.jobId;
      setBusy(job.action === "restore" ? "restore" : "backup");
      try {
        report(await settled({ ...job, ok: true }));
        await load();
      } finally {
        polling.current = null;
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report and settled read only props and constants
    [load],
  );

  useEffect(() => {
    void load().then((body) => {
      if (body?.job) void follow(body.job);
    });
  }, [load, follow]);

  const post = async (path: string, body: Record<string, unknown>): Promise<BackupOutcome & { ok: boolean }> => {
    const res = await appFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await res.json().catch(() => ({}))) as Partial<BackupOutcome> & { error?: string };
    if (!res.ok && res.status !== 202) throw new Error(answer.error ?? `The request failed (${res.status})`);
    const outcome = { action: "create" as const, status: "done", ...answer, ok: res.ok } as BackupOutcome & {
      ok: boolean;
    };
    if (res.status === 202) {
      polling.current = outcome.jobId;
      toast.info(`${outcome.action === "restore" ? "Restore" : "Backup"} queued; a worker is taking it`);
    }
    return settled(outcome);
  };

  const backup = async () => {
    setBusy("backup");
    try {
      report(await post("/api/admin/backups", { datasourceId }));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The backup failed");
    } finally {
      polling.current = null;
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!pendingRestore) return;
    const name = pendingRestore;
    setPendingRestore(null);
    setBusy("restore");
    try {
      report(await post("/api/admin/backups/restore", { datasourceId, name }), name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The restore failed");
    } finally {
      polling.current = null;
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
