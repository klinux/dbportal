"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { JobStats } from "@/lib/jobs/stats";
import type { JobRecord, JobStatus } from "@/lib/storage/types";
import { cn } from "@/lib/utils";
import { Activity, RefreshCw, Send, Workflow } from "lucide-react";
import { toast } from "sonner";

/**
 * The job queue as an administrator watches it (docs/CONTEXT.md §4.40): what waits and runs
 * now, what settled over a window and how long it waited and ran, by kind, the workers
 * seen, and the latest jobs. A ping proves a worker is there and says how long the round
 * trip took. Everything is read from the server; the page computes nothing of its own.
 */
export const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: "1 h" },
  { hours: 24, label: "24 h" },
  { hours: 7 * 24, label: "7 d" },
];
export const STATUS_FILTERS: (JobStatus | "all")[] = ["all", "queued", "running", "done", "failed", "lost"];
export const PING_WAIT_MS = 3_000;
const LIST_LIMIT = 50;

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const STATUS_VARIANT: Record<JobStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "default",
  done: "secondary",
  failed: "destructive",
  lost: "destructive",
};

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  return (
    <div className="p-3 rounded-xl border border-hairline bg-fill-subtle min-w-0" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="text-lg font-semibold text-fg-primary tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-fg-muted">{hint}</p>}
    </div>
  );
}

/** Who leads the alert scheduler (§4.41), read off the store's leases; what a rollout of several studios is checked by. */
function Leader({ stats }: { stats: JobStats }) {
  const leader = stats.schedulerLeader;
  return (
    <p className="text-xs text-fg-secondary border-t border-hairline pt-2" data-testid="scheduler-leader">
      Alert scheduler:{" "}
      {leader ? (
        <>
          <span className="font-mono">{leader}</span>
          {leader === stats.instance ? " (this instance)" : ""}
        </>
      ) : (
        <span className="text-fg-muted">no leader yet</span>
      )}
      <span className="block text-[11px] text-fg-muted">
        Answered by <span className="font-mono">{stats.instance || "–"}</span>
      </span>
    </p>
  );
}

export function JobsTab() {
  const [hours, setHours] = useState(24);
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [stats, setStats] = useState<JobStats | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pinging, setPinging] = useState(false);

  const load = useCallback(() => {
    const list = `/api/admin/jobs?limit=${LIST_LIMIT}${status === "all" ? "" : `&status=${status}`}`;
    return Promise.all([appFetch(`/api/admin/jobs/stats?hours=${hours}`), appFetch(list)])
      .then(async ([statsRes, listRes]) => {
        const statsBody = (await statsRes.json().catch(() => ({}))) as JobStats & { error?: string };
        const listBody = (await listRes.json().catch(() => ({}))) as { jobs?: JobRecord[]; error?: string };
        if (!statsRes.ok) throw new Error(statsBody.error ?? `HTTP ${statsRes.status}`);
        if (!listRes.ok) throw new Error(listBody.error ?? `HTTP ${listRes.status}`);
        setStats(statsBody);
        setJobs(listBody.jobs ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "The queue could not be read"))
      .finally(() => setLoading(false));
  }, [hours, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setLoading(true);
    void load();
  };

  /** A ping on the queue: enqueued, read back after a moment, the round trip told. */
  const ping = async () => {
    setPinging(true);
    try {
      const res = await appFetch("/api/admin/jobs/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ echo: "jobs-page" }),
      });
      const body = (await res.json().catch(() => ({}))) as { job?: JobRecord; error?: string };
      if (!res.ok || !body.job) throw new Error(body.error ?? `The ping was refused (${res.status})`);
      await new Promise((r) => setTimeout(r, PING_WAIT_MS));
      const after = await appFetch(`/api/admin/jobs?kind=ping&limit=${LIST_LIMIT}`);
      const listed = ((await after.json().catch(() => ({}))) as { jobs?: JobRecord[] }).jobs ?? [];
      const answered = listed.find((j) => j.id === body.job?.id);
      if (answered?.status === "done" && answered.finishedAt) {
        toast.success(
          `A worker answered in ${formatMs(Date.parse(answered.finishedAt) - Date.parse(answered.createdAt))}` +
            (answered.worker ? ` (${answered.worker})` : ""),
        );
      } else {
        toast.info(`No worker answered within ${PING_WAIT_MS / 1_000} s; the ping is ${answered?.status ?? "queued"}`);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The ping failed");
    } finally {
      setPinging(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="jobs-tab">
      <AdminSectionHeader
        icon={Workflow}
        title="Jobs"
        description="The queue the workers consume: bot executions, alert runs, seeds, exports and backups. What waits now, what settled over the window, and how long each kind took."
        actions={
          <div className="flex items-center gap-2">
            <fieldset className="flex items-center rounded-md border border-hairline-strong overflow-hidden m-0 p-0">
              <legend className="sr-only">Window</legend>
              {WINDOWS.map((w) => (
                <button
                  key={w.hours}
                  type="button"
                  onClick={() => setHours(w.hours)}
                  aria-pressed={hours === w.hours}
                  className={cn(
                    "px-2.5 h-7 text-xs transition-colors",
                    hours === w.hours ? "bg-brand/10 text-brand" : "text-fg-muted hover:text-fg-secondary",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </fieldset>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={refresh} disabled={loading}>
              <RefreshCw className={cn("w-3 h-3 mr-1", loading && "animate-spin")} /> Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-hairline-strong"
              onClick={ping}
              disabled={pinging}
            >
              {pinging ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : <Send className="w-3 h-3 mr-1" />}
              Ping a worker
            </Button>
          </div>
        }
      />

      {error ? (
        <output className="block text-xs text-status-danger" data-testid="jobs-error">
          {error}
        </output>
      ) : !stats ? (
        <p className="text-xs text-fg-muted" data-testid="jobs-loading">
          Loading…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="Queued now" value={String(stats.queued)} testId="stat-queued" />
            <Stat label="Running now" value={String(stats.running)} testId="stat-running" />
            <Stat
              label={`Settled, ${stats.hours} h`}
              value={String(stats.total)}
              hint={`${stats.done} done`}
              testId="stat-total"
            />
            <Stat
              label="Failed or lost"
              value={String(stats.failed + stats.lost)}
              hint={stats.lost > 0 ? `${stats.lost} lost` : undefined}
              testId="stat-failed"
            />
            <Stat
              label="Wait p50 / p95"
              value={`${formatMs(stats.wait?.p50Ms)} / ${formatMs(stats.wait?.p95Ms)}`}
              hint="before a worker took it"
              testId="stat-wait"
            />
            <Stat
              label="Run p50 / p95"
              value={`${formatMs(stats.run?.p50Ms)} / ${formatMs(stats.run?.p95Ms)}`}
              hint="on the worker"
              testId="stat-run"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-xl border border-hairline overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-hairline hover:bg-transparent">
                    <TableHead className="text-xs">Kind</TableHead>
                    <TableHead className="text-xs text-right">Settled</TableHead>
                    <TableHead className="text-xs text-right">Failed</TableHead>
                    <TableHead className="text-xs text-right">Lost</TableHead>
                    <TableHead className="text-xs text-right">Wait p50 / p95</TableHead>
                    <TableHead className="text-xs text-right">Run p50 / p95</TableHead>
                    <TableHead className="text-xs text-right">Run max</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.kinds.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-xs text-fg-muted" data-testid="kinds-empty">
                        No job settled in the last {stats.hours} h.
                      </TableCell>
                    </TableRow>
                  ) : (
                    stats.kinds.map((k) => (
                      <TableRow key={k.kind} className="border-hairline" data-testid={`kind-${k.kind}`}>
                        <TableCell className="text-xs font-mono">{k.kind}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{k.total}</TableCell>
                        <TableCell
                          className={cn("text-xs text-right tabular-nums", k.failed > 0 && "text-status-danger")}
                        >
                          {k.failed}
                        </TableCell>
                        <TableCell
                          className={cn("text-xs text-right tabular-nums", k.lost > 0 && "text-status-danger")}
                        >
                          {k.lost}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatMs(k.wait?.p50Ms)} / {formatMs(k.wait?.p95Ms)}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatMs(k.run?.p50Ms)} / {formatMs(k.run?.p95Ms)}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{formatMs(k.run?.maxMs)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-xl border border-hairline p-4 space-y-2" data-testid="workers">
              <h3 className="text-sm font-bold text-fg-secondary flex items-center gap-2">
                <Activity className="h-4 w-4 text-brand" /> Workers seen
              </h3>
              {stats.workers.length === 0 ? (
                <p className="text-xs text-fg-muted" data-testid="workers-empty">
                  No worker finished a job in the last {stats.hours} h. Ping one to find out whether any is there.
                </p>
              ) : (
                <ul className="divide-y divide-hairline">
                  {stats.workers.map((w) => (
                    <li key={w.name} className="py-2 text-xs flex items-center justify-between gap-2">
                      <span className="font-mono text-fg-secondary truncate">{w.name}</span>
                      <span className="text-fg-muted whitespace-nowrap tabular-nums">
                        {w.jobs} job{w.jobs === 1 ? "" : "s"} · {new Date(w.lastSeenAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-fg-muted">
                From the latest {stats.sample} records{stats.sample >= 2_000 ? " (the window may hold more)" : ""}.
              </p>
              <Leader stats={stats} />
            </div>
          </div>

          <div className="space-y-2">
            <fieldset className="flex items-center gap-1 flex-wrap m-0 p-0 border-0">
              <legend className="sr-only">Status</legend>
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={status === s}
                  className={cn(
                    "px-2.5 h-7 text-xs rounded-md border transition-colors",
                    status === s
                      ? "border-brand/40 bg-brand/10 text-brand"
                      : "border-hairline text-fg-muted hover:text-fg-secondary",
                  )}
                >
                  {s === "all" ? "All" : s}
                </button>
              ))}
            </fieldset>
            <div className="rounded-xl border border-hairline overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-hairline hover:bg-transparent">
                    <TableHead className="text-xs">Job</TableHead>
                    <TableHead className="text-xs">Kind</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Requested by</TableHead>
                    <TableHead className="text-xs">Created</TableHead>
                    <TableHead className="text-xs text-right">Waited</TableHead>
                    <TableHead className="text-xs text-right">Ran</TableHead>
                    <TableHead className="text-xs">Worker</TableHead>
                    <TableHead className="text-xs text-right">Attempts</TableHead>
                    <TableHead className="text-xs">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-xs text-fg-muted" data-testid="jobs-empty">
                        No job {status === "all" ? "yet" : status}.
                      </TableCell>
                    </TableRow>
                  ) : (
                    jobs.map((job) => (
                      <TableRow key={job.id} className="border-hairline" data-testid={`job-${job.id}`}>
                        <TableCell className="text-xs font-mono text-fg-muted">{job.id.slice(0, 8)}</TableCell>
                        <TableCell className="text-xs font-mono">{job.kind}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[job.status]} className="text-[10px]">
                            {job.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{job.requestedBy}</TableCell>
                        <TableCell className="text-xs text-fg-muted whitespace-nowrap">
                          {new Date(job.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatMs(job.startedAt ? Date.parse(job.startedAt) - Date.parse(job.createdAt) : null)}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {formatMs(
                            job.startedAt && job.finishedAt
                              ? Date.parse(job.finishedAt) - Date.parse(job.startedAt)
                              : null,
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-fg-muted">{job.worker ?? "–"}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {job.attempts}/{job.maxAttempts}
                        </TableCell>
                        <TableCell className="text-xs text-status-danger font-mono">{job.error ?? ""}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
