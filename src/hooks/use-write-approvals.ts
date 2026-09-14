"use client";

import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { appFetch } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";
import type { QueryTab, TabApproval } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";

/**
 * The client half of write approval (docs/CONTEXT.md §4.6): watches the requests this
 * session's tabs are waiting on, and knows which datasources currently have an open write
 * window for this person - the countdown chip in the toolbar reads from here.
 *
 * Polling, not a stream: a request is decided by a person, minutes apart, and a 5 s poll
 * of one small record per waiting tab is the whole cost. Nothing polls when nothing waits.
 */
export const APPROVAL_POLL_MS = 5_000;
/** How long the chip keeps showing a closed window (in the denied palette) before it goes. */
export const CLOSED_WINDOW_GRACE_MS = 60_000;

export interface WriteWindow {
  until: string;
  reviewer: string;
}

interface ApprovalRecord extends TabApproval {
  requester?: string;
}

interface UseWriteApprovalsParams {
  tabs: QueryTab[];
  setTabs: Dispatch<SetStateAction<QueryTab[]>>;
  /** Tests only: how often a waiting request is checked. */
  pollMs?: number;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function useWriteApprovals({ tabs, setTabs, pollMs = APPROVAL_POLL_MS }: UseWriteApprovalsParams) {
  const [windows, setWindows] = useState<Record<string, WriteWindow>>({});
  const { toast } = useToast();

  // The latest window per datasource wins: the list arrives newest first, and an older,
  // closed approval for the same datasource must not overwrite the one that is open.
  const remember = useCallback((record: ApprovalRecord) => {
    if (record.status !== "approved" || !record.windowUntil || !record.reviewer) return;
    const until = record.windowUntil;
    const reviewer = record.reviewer;
    setWindows((prev) => {
      const existing = prev[record.datasourceId];
      if (existing && Date.parse(existing.until) >= Date.parse(until)) return prev;
      return { ...prev, [record.datasourceId]: { until, reviewer } };
    });
  }, []);

  // The windows this person already holds, once: a reload must not lose a chip mid-window.
  useEffect(() => {
    let cancelled = false;
    appFetch("/api/approvals?scope=mine")
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { approvals?: ApprovalRecord[] };
        for (const record of body.approvals ?? []) remember(record);
      })
      .catch((error) => {
        logger.warn("Open write windows could not be read", {
          route: "use-write-approvals",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [remember]);

  const pendingIds = tabs
    .filter((tab) => tab.approval?.status === "pending")
    .map((tab) => tab.approval!.id)
    .sort()
    .join(",");

  // One poll per waiting request, only while something waits.
  useEffect(() => {
    if (!pendingIds) return;
    let cancelled = false;
    const check = async () => {
      // Every waiting request at once: they are independent, and one slow answer must not
      // delay the others' decisions.
      await Promise.all(
        pendingIds.split(",").map(async (id) => {
          try {
            const res = await appFetch(`/api/approvals/${encodeURIComponent(id)}`);
            if (!res.ok || cancelled) return;
            const { approval } = (await res.json()) as { approval: ApprovalRecord };
            if (approval.status === "pending") return;
            setTabs((prev) =>
              prev.map((tab) =>
                tab.approval?.id === id
                  ? {
                      ...tab,
                      approval: {
                        ...tab.approval,
                        status: approval.status,
                        reviewer: approval.reviewer,
                        windowUntil: approval.windowUntil,
                      },
                    }
                  : tab,
              ),
            );
            if (approval.status === "approved") {
              remember(approval);
              toast({
                title: "Write approved",
                description: `${approval.reviewer} opened a window on "${approval.datasourceName}" until ${fmtTime(approval.windowUntil!)}. Run the statement again.`,
              });
            } else if (approval.status === "expired") {
              // docs/CONTEXT.md §4.28: nobody decided in time; running again asks again.
              toast({
                title: "Approval request expired",
                description: `Nobody reviewed the request on "${approval.datasourceName}" in time. Run the statement again to ask again.`,
                variant: "destructive",
              });
            } else {
              toast({
                title: "Write rejected",
                description: `${approval.reviewer} rejected the request on "${approval.datasourceName}".`,
                variant: "destructive",
              });
            }
          } catch (error) {
            logger.warn("Approval status check failed", {
              route: "use-write-approvals",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    };
    const timer = setInterval(check, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingIds, setTabs, remember, toast, pollMs]);

  // A closed window leaves the chip after a grace period; checked once a second, only
  // while there is a window to check (the chip keeps its own clock for the countdown).
  const hasWindows = Object.keys(windows).length > 0;
  useEffect(() => {
    if (!hasWindows) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setWindows((prev) => {
        const kept = Object.fromEntries(
          Object.entries(prev).filter(([, w]) => Date.parse(w.until) + CLOSED_WINDOW_GRACE_MS > now),
        );
        return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [hasWindows]);

  /** The window for a datasource (by its seed id), open or just closed, or null. */
  const windowFor = useCallback(
    (datasourceId: string | undefined): WriteWindow | null => {
      if (!datasourceId) return null;
      return windows[datasourceId] ?? null;
    },
    [windows],
  );

  return { windowFor, remember };
}
