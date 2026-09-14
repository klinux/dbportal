"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * The admin Audit page's filters and pager (docs/CONTEXT.md §4.27): who, which datasource,
 * which period, and which page of the store's answer. The store does the narrowing; these
 * only ask.
 */
export interface AuditFilterValues {
  actor: string;
  connection: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterValues = { actor: "", connection: "", from: "", to: "" };

/** A `datetime-local` value as the instant the API wants, or nothing for a blank or unreadable one. */
export function toInstantParam(local: string): string | undefined {
  if (!local) return undefined;
  const ms = Date.parse(local);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The query string the filters and the page make, in one place for both tabs. */
export function auditPageParams(input: {
  type?: string;
  filters: AuditFilterValues;
  limit: number;
  offset: number;
}): URLSearchParams {
  const params = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
  if (input.type && input.type !== "all") params.set("type", input.type);
  if (input.filters.actor.trim()) params.set("actor", input.filters.actor.trim());
  if (input.filters.connection.trim()) params.set("connection", input.filters.connection.trim());
  const from = toInstantParam(input.filters.from);
  const to = toInstantParam(input.filters.to);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}

export function AuditFilters({
  values,
  onChange,
  idPrefix,
}: {
  values: AuditFilterValues;
  onChange: (next: AuditFilterValues) => void;
  idPrefix: string;
}) {
  const field = "h-8 text-xs bg-panel border-hairline-strong";
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid={`${idPrefix}-filters`}>
      <Input
        aria-label="Actor"
        placeholder="Actor"
        value={values.actor}
        onChange={(e) => onChange({ ...values, actor: e.target.value })}
        className={`${field} w-[160px]`}
      />
      <Input
        aria-label="Datasource"
        placeholder="Datasource"
        value={values.connection}
        onChange={(e) => onChange({ ...values, connection: e.target.value })}
        className={`${field} w-[160px]`}
      />
      <Input
        aria-label="From"
        type="datetime-local"
        value={values.from}
        onChange={(e) => onChange({ ...values, from: e.target.value })}
        className={`${field} w-[190px]`}
      />
      <Input
        aria-label="To"
        type="datetime-local"
        value={values.to}
        onChange={(e) => onChange({ ...values, to: e.target.value })}
        className={`${field} w-[190px]`}
      />
    </div>
  );
}

export function AuditPager({
  offset,
  limit,
  total,
  shown,
  onPage,
  idPrefix,
}: {
  offset: number;
  limit: number;
  total: number;
  shown: number;
  onPage: (offset: number) => void;
  idPrefix: string;
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted" data-testid={`${idPrefix}-pager`}>
      <span data-testid={`${idPrefix}-page-range`}>
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => onPage(Math.max(0, offset - limit))}
        disabled={offset === 0}
        aria-label="Previous page"
      >
        <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => onPage(offset + limit)}
        disabled={offset + limit >= total}
        aria-label="Next page"
      >
        <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.75} />
      </Button>
    </div>
  );
}
