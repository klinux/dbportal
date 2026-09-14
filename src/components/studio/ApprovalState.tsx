"use client";

import { ClipboardCheck, Clock, XCircle } from "lucide-react";
import { GUARDRAIL_LABEL, type Guardrail } from "@/lib/guardrails";
import type { TabApproval } from "@/lib/types";

/**
 * The result area while a write waits for a reviewer, and once it was decided
 * (docs/CONTEXT.md §4.6, DESIGN.md "Approval flow"): what was asked, of whom, and what to
 * do next. Replaces the empty state, never a result - a run that produced rows shows them.
 */
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ApprovalState({ approval }: { approval: TabApproval }) {
  if (approval.status === "approved") {
    return (
      <div
        className="h-full flex flex-col items-center justify-center text-center px-6 bg-surface"
        data-testid="approval-state-approved"
      >
        <ClipboardCheck className="w-10 h-10 mb-3 text-status-success" strokeWidth={1.5} />
        <p className="text-sm font-medium text-fg-primary">Write approved</p>
        <p className="text-xs text-fg-tertiary mt-1 max-w-md leading-relaxed">
          {approval.reviewer} opened a write window on &ldquo;{approval.datasourceName}&rdquo;
          {approval.windowUntil ? ` until ${fmtTime(approval.windowUntil)}` : ""}. Run the statement again.
        </p>
      </div>
    );
  }
  if (approval.status === "rejected") {
    return (
      <div
        className="h-full flex flex-col items-center justify-center text-center px-6 bg-surface"
        data-testid="approval-state-rejected"
      >
        <XCircle className="w-10 h-10 mb-3 text-status-danger" strokeWidth={1.5} />
        <p className="text-sm font-medium text-fg-primary">Write rejected</p>
        <p className="text-xs text-fg-tertiary mt-1 max-w-md leading-relaxed">
          {approval.reviewer} rejected the request on &ldquo;{approval.datasourceName}&rdquo;. Nothing ran.
        </p>
      </div>
    );
  }
  if (approval.status === "expired") {
    return (
      <div
        className="h-full flex flex-col items-center justify-center text-center px-6 bg-surface"
        data-testid="approval-state-expired"
      >
        <Clock className="w-10 h-10 mb-3 text-fg-muted" strokeWidth={1.5} />
        <p className="text-sm font-medium text-fg-primary">Request expired</p>
        <p className="text-xs text-fg-tertiary mt-1 max-w-md leading-relaxed">
          Nobody reviewed the request on &ldquo;{approval.datasourceName}&rdquo; in time. Nothing ran; run the statement
          again to ask again.
        </p>
      </div>
    );
  }
  return (
    <div
      className="h-full flex flex-col items-center justify-center text-center px-6 bg-surface"
      data-testid="approval-state-pending"
    >
      <Clock className="w-10 h-10 mb-3 text-status-warning" strokeWidth={1.5} />
      <p className="text-sm font-medium text-fg-primary">Awaiting approval</p>
      <p className="text-xs text-fg-tertiary mt-1 max-w-md leading-relaxed">
        Writes on &ldquo;{approval.datasourceName}&rdquo; need a reviewer. The statement did not run; this tab checks
        every few seconds and tells you when a window opens.
      </p>
      {approval.guardrail && (
        <p className="text-xs text-fg-tertiary mt-2 max-w-md leading-relaxed" data-testid="approval-guardrail">
          It waits because it trips a guardrail:{" "}
          <span className="font-medium">{GUARDRAIL_LABEL[approval.guardrail as Guardrail] ?? approval.guardrail}</span>.
        </p>
      )}
      <p className="text-[11px] font-mono text-fg-muted mt-3">request {approval.id}</p>
    </div>
  );
}
