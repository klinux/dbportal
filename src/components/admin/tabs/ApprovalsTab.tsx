"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";

import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClipboardCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { GUARDRAIL_LABEL } from "@/lib/guardrails";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The reviewer's list (docs/CONTEXT.md §4.6): every pending write request on a datasource
 * this session may review, the statement that prompted it, and two decisions - approve for
 * a window of minutes, or reject. Recent decisions follow, so a reviewer sees what was
 * granted and until when.
 */
const WINDOW_CHOICES = [15, 60, 240] as const;

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** What a decided row says after the badge: the window a person got, or what a queued execution did. */
export function outcomeLabel(record: ApprovalRequest, now: number): string {
  if (record.kind === "execution") {
    const outcome = record.execution;
    if (record.status !== "approved") return "";
    if (!outcome) return "not run";
    if (outcome.status === "failed") return `failed: ${outcome.error ?? "execution_failed"}`;
    const rows = outcome.rowCount ?? outcome.rows?.length ?? 0;
    return `${rows} row${rows === 1 ? "" : "s"} in ${outcome.durationMs} ms`;
  }
  return windowLabel(record, now);
}

function windowLabel(record: ApprovalRequest, now: number): string {
  if (record.status !== "approved" || !record.windowUntil) return "";
  const left = Date.parse(record.windowUntil) - now;
  return left > 0 ? `open for ${Math.ceil(left / 60_000)} min` : "window closed";
}

/** The requester, and for a bot's request the person it acted for (§4.10). */
function Who({ record }: { record: ApprovalRequest }) {
  if (record.kind !== "execution") return <>{record.requester}</>;
  return (
    <span>
      {record.subject ?? record.requester}
      <span className="block font-mono text-[10px] text-fg-muted">via {record.requester}</span>
    </span>
  );
}

async function fetchApprovals(): Promise<ApprovalRequest[]> {
  const res = await appFetch("/api/approvals");
  if (!res.ok) throw new Error(`Approvals could not be loaded (${res.status})`);
  const body = (await res.json()) as { approvals: ApprovalRequest[] };
  return body.approvals;
}

export function ApprovalsTab() {
  const [approvals, setApprovals] = useState<ApprovalRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The promise chain keeps every state write off the mount effect's own tick (the same
  // shape DatasourcesTab uses); a refresh and a decision call the same `load`.
  const load = useCallback(
    () =>
      fetchApprovals()
        .then((list) => {
          setApprovals(list);
          setError(null);
          setNow(Date.now());
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Approvals could not be loaded");
        }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (record: ApprovalRequest, decision: "approve" | "reject", windowMinutes?: number) => {
    setBusy(record.id);
    try {
      const res = await appFetch(`/api/approvals/${encodeURIComponent(record.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(windowMinutes ? { windowMinutes } : {}) }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The decision was refused (${res.status})`);
      toast.success(
        decision === "reject"
          ? `Request from ${record.requester} rejected`
          : record.kind === "execution"
            ? `Ran on "${record.datasourceName}" for ${record.subject ?? record.requester}`
            : `${record.requester} may write on "${record.datasourceName}" for ${windowMinutes} min`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The decision was refused");
    } finally {
      setBusy(null);
    }
  };

  const pending = approvals?.filter((a) => a.status === "pending") ?? [];
  const decided = approvals?.filter((a) => a.status !== "pending") ?? [];

  return (
    <div className="space-y-6">
      <AdminSectionHeader
        icon={ClipboardCheck}
        title="Write approvals"
        description="A write on a datasource that requires approval does not run until a reviewer opens a write window for the person who asked. Approve for a bounded number of minutes; the person runs the statement again."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-2"
              onClick={() => load()}
              disabled={!approvals && !error}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Refresh
            </Button>
          </>
        }
      />

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="approvals-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!approvals && !error ? (
        <div className="space-y-2" data-testid="approvals-loading">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-fg-tertiary">
              Pending ({pending.length})
            </h3>
            {pending.length === 0 ? (
              <p className="text-xs text-fg-muted" data-testid="approvals-empty">
                Nothing is waiting for a decision.
              </p>
            ) : (
              <div className="border border-hairline rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Who</TableHead>
                      <TableHead className="text-xs">Datasource</TableHead>
                      <TableHead className="text-xs">Statement</TableHead>
                      <TableHead className="text-xs">Asked</TableHead>
                      <TableHead className="text-xs text-right">Decision</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((record) => (
                      <TableRow key={record.id} data-testid={`approval-${record.id}`}>
                        <TableCell className="text-xs text-fg-secondary">
                          <Who record={record} />
                        </TableCell>
                        <TableCell className="text-xs text-fg-secondary">{record.datasourceName}</TableCell>
                        <TableCell className="text-xs">
                          {record.guardrail && (
                            <Badge
                              variant="outline"
                              className="mb-1 text-[10px] text-status-danger border-status-danger/40"
                            >
                              guardrail: {GUARDRAIL_LABEL[record.guardrail]}
                            </Badge>
                          )}
                          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all max-w-xl text-fg-secondary">
                            {record.statement}
                          </pre>
                          {record.ticket && (
                            <div
                              className="font-mono text-[10px] text-fg-muted mt-1"
                              data-testid={`ticket-${record.id}`}
                            >
                              ticket {record.ticket}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-fg-tertiary whitespace-nowrap">
                          {ago(record.requestedAt, now)}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {/* docs/CONTEXT.md §4.10: a queued execution runs once, now; there is no window to size. */}
                            {record.kind === "execution" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[11px] px-2"
                                disabled={busy === record.id}
                                onClick={() => decide(record, "approve")}
                                aria-label={`Run request from ${record.subject ?? record.requester}`}
                              >
                                Run now
                              </Button>
                            )}
                            {record.kind !== "execution" &&
                              WINDOW_CHOICES.map((minutes) => (
                                <Button
                                  key={minutes}
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] px-2"
                                  disabled={busy === record.id}
                                  onClick={() => decide(record, "approve", minutes)}
                                  aria-label={`Approve ${record.requester} for ${minutes} minutes`}
                                >
                                  {minutes} min
                                </Button>
                              ))}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[11px] px-2 text-status-danger"
                              disabled={busy === record.id}
                              onClick={() => decide(record, "reject")}
                              aria-label={`Reject request from ${record.requester}`}
                            >
                              Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {decided.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-fg-tertiary">Recent decisions</h3>
              <div className="border border-hairline rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Who</TableHead>
                      <TableHead className="text-xs">Datasource</TableHead>
                      <TableHead className="text-xs">Decision</TableHead>
                      <TableHead className="text-xs">Reviewer</TableHead>
                      <TableHead className="text-xs">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {decided.map((record) => (
                      <TableRow key={record.id} data-testid={`approval-${record.id}`}>
                        <TableCell className="text-xs text-fg-secondary">
                          <Who record={record} />
                        </TableCell>
                        <TableCell className="text-xs text-fg-secondary">{record.datasourceName}</TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={record.status === "approved" ? "secondary" : "outline"}
                            className="text-[10px]"
                          >
                            {record.status}
                          </Badge>
                          {record.status === "approved" && (
                            <span className="ml-2 text-[11px] text-fg-tertiary">{outcomeLabel(record, now)}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-fg-secondary">{record.reviewer}</TableCell>
                        <TableCell className="text-xs text-fg-tertiary whitespace-nowrap">
                          {record.reviewedAt ? ago(record.reviewedAt, now) : ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
