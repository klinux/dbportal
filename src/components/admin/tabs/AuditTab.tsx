"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ADMIN_SUBTAB_LIST_CLASS, ADMIN_SUBTAB_TRIGGER_CLASS } from "@/lib/ui/admin-tabs";
import { formatStatement, statementOverview } from "@/lib/audit-view/statement";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Wrench,
  Search as SearchIcon,
  ChartColumn,
  CircleCheck,
  CircleX,
  RefreshCw,
  Clock,
  Activity,
  Download,
  FileText,
  ChevronRight,
} from "lucide-react";
import type { AuditEvent } from "@/lib/audit";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { format, subDays, startOfDay } from "date-fns";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { chartTooltipStyle } from "@/lib/charts/palette";
import { csvRow } from "@/lib/export/csv";
import { jsonText } from "@/lib/export/json";
import { downloadText } from "@/lib/export/download";

interface AuditExportProps {
  disabled: boolean;
  onExport: (format: "csv" | "json") => void;
}

function AuditExport({ disabled, onExport }: AuditExportProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-2" disabled={disabled}>
          <Download className="w-3 h-3" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onExport("csv")}>Export as CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("json")}>Export as JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AuditTab() {
  return (
    <div className="space-y-6">
      <AdminSectionHeader
        icon={FileText}
        title="Audit"
        description="Every execution and every maintenance operation, who ran it and how it ended. The stdout log is the record; this is the view."
      />
      <Tabs defaultValue="operations">
        <TabsList className={ADMIN_SUBTAB_LIST_CLASS}>
          <TabsTrigger value="operations" className={ADMIN_SUBTAB_TRIGGER_CLASS}>
            <Wrench className="h-3.5 w-3.5" />
            Operations
          </TabsTrigger>
          <TabsTrigger value="queries" className={ADMIN_SUBTAB_TRIGGER_CLASS}>
            <SearchIcon className="h-3.5 w-3.5" />
            Queries
          </TabsTrigger>
          <TabsTrigger value="stats" className={ADMIN_SUBTAB_TRIGGER_CLASS}>
            <ChartColumn className="h-3.5 w-3.5" />
            Stats
          </TabsTrigger>
        </TabsList>

        <TabsContent value="operations" className="mt-4">
          <OperationsAudit />
        </TabsContent>
        <TabsContent value="queries" className="mt-4">
          <QueryAudit />
        </TabsContent>
        <TabsContent value="stats" className="mt-4">
          <AuditStats />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The audit read, kept free of state writes so the Effect below can stay in the
 * shape react.dev prescribes for fetching. A failed request reads as "no events"
 * — the same thing the old catch branch put on screen.
 */
async function loadAuditEvents(type: string, limit = 200): Promise<AuditEvent[]> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (type !== "all") params.set("type", type);
    const res = await appFetch(`/api/admin/audit?${params}`);
    const data = await res.json();
    return data.events || [];
  } catch {
    return [];
  }
}

function OperationsAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [refreshCount, setRefreshCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  // The descriptor bundles which events to ask for with which request this is, so the
  // Effect below stays the ONLY writer of `events`. A refresh that fetched on its own
  // would be a second, unguarded writer: one still in flight when the filter changed
  // would land last and repopulate the table with the previous filter's rows.
  // (Bundling matters: a bare refresh token is never read inside the Effect, so it
  // cannot honestly be a dependency — inside the descriptor it is the value the Effect
  // synchronizes against. Same shape as OverviewTab's fleet health.)
  const auditRequest = useMemo(() => ({ typeFilter, refreshCount }), [typeFilter, refreshCount]);

  useEffect(() => {
    const { typeFilter: requestedType } = auditRequest;
    let ignore = false;
    async function run() {
      const next = await loadAuditEvents(requestedType);
      // A response that lost the race (unmount, a newer filter, or a newer refresh)
      // must not win.
      if (ignore) return;
      setEvents(next);
      setLoading(false);
    }
    run();
    return () => {
      ignore = true;
    };
  }, [auditRequest]);

  // The spinner turns on because the user acted, so it belongs to the event that
  // caused it rather than to the Effect that follows. Both handlers only ask for a
  // new synchronization; neither touches `events`.
  const handleTypeChange = (value: string) => {
    setLoading(true);
    setTypeFilter(value);
  };

  const handleRefresh = () => {
    setLoading(true);
    setRefreshCount((c) => c + 1);
  };

  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    const q = searchQuery.toLowerCase();
    return events.filter(
      (e) =>
        e.action.toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q) ||
        (e.connectionName || "").toLowerCase().includes(q),
    );
  }, [events, searchQuery]);

  const exportEvents = (format: "csv" | "json") => {
    let content: string;
    if (format === "csv") {
      const headers = [
        "Timestamp",
        "Type",
        "Action",
        "Target",
        "Connection",
        "User",
        "Result",
        "Duration (ms)",
        "Details",
        "IP",
        "Reason",
        "Bucket",
        "Correlation ID",
        "ID",
      ];
      const rows = filteredEvents.map((event) =>
        csvRow([
          event.timestamp,
          event.type,
          event.action,
          event.target,
          event.connectionName,
          event.user,
          event.result,
          event.duration,
          event.details,
          event.ip,
          event.reason,
          event.bucket,
          event.correlationId,
          event.id,
        ]),
      );
      content = [csvRow(headers), ...rows].join("\n");
    } else {
      content = jsonText(filteredEvents, 2);
    }
    downloadText(
      content,
      format === "csv" ? "text/csv" : "application/json",
      `audit_operations_${Date.now()}.${format}`,
    );
  };

  const successCount = events.filter((e) => e.result === "success").length;
  const successRate = events.length > 0 ? Math.round((successCount / events.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={typeFilter} onValueChange={handleTypeChange}>
          <SelectTrigger className="w-[140px] h-8 text-xs bg-panel border-hairline-strong">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="maintenance">Maintenance</SelectItem>
            <SelectItem value="kill_session">Kill Session</SelectItem>
            <SelectItem value="masking_config">Masking</SelectItem>
            <SelectItem value="threshold_config">Thresholds</SelectItem>
            <SelectItem value="login_success">Login Success</SelectItem>
            <SelectItem value="login_failure">Login Failure</SelectItem>
            <SelectItem value="logout">Logout</SelectItem>
            <SelectItem value="permission_denied">Permission Denied</SelectItem>
            <SelectItem value="rate_limit_exceeded">Rate Limited</SelectItem>
            <SelectItem value="credential_issued">Credential Issued</SelectItem>
            <SelectItem value="approval_decision">Approval Decision</SelectItem>
            <SelectItem value="masking_reveal">Masking Reveal</SelectItem>
            <SelectItem value="ssh_profile">SSH Profile</SelectItem>
            <SelectItem value="service_token">Service Token</SelectItem>
            <SelectItem value="backup">Backup</SelectItem>
            <SelectItem value="freeze_window">Freeze Window</SelectItem>
            <SelectItem value="data_export">Export</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-[180px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-fg-muted hover:text-fg-secondary ml-auto"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`w-3 h-3 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <AuditExport disabled={loading || filteredEvents.length === 0} onExport={exportEvents} />
      </div>

      {/* Stats Summary */}
      <div className="flex items-center gap-4 text-xs text-fg-muted">
        <span>
          Total: <span className="font-bold text-fg-secondary">{events.length}</span> ops
        </span>
        <span>
          Success: <span className="font-bold text-success">{successRate}%</span>
        </span>
      </div>

      {/* Events Table */}
      <div className="rounded-xl border border-hairline bg-panel overflow-hidden">
        {loading && events.length === 0 ? (
          <div className="p-4 space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full bg-overlay" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-fg-subtle text-sm">
            <Wrench className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No audit events found.</p>
            <p className="text-xs mt-1 text-fg-faint">Operations will appear here when maintenance tasks are run.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-hairline hover:bg-transparent">
                <TableHead className="text-xs text-fg-muted font-bold uppercase w-[30px]" />
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Time</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Action</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Target</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden md:table-cell">
                  Connection
                </TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden lg:table-cell">User</TableHead>
                <TableHead className="text-right text-xs text-fg-muted font-bold uppercase">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvents.map((event) => (
                <TableRow key={event.id} className="border-hairline hover:bg-fill">
                  <TableCell className="py-2">
                    {event.result === "success" ? (
                      <CircleCheck className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <CircleX className="w-3.5 h-3.5 text-danger" />
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-fg-muted">
                    {new Date(event.timestamp).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge variant="outline" className="text-[0.625rem] font-bold border-hairline-strong">
                      {event.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-fg-tertiary truncate max-w-[120px]">
                    {event.target}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-fg-muted hidden md:table-cell truncate max-w-[100px]">
                    {event.connectionName || "-"}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-fg-muted hidden lg:table-cell">{event.user}</TableCell>
                  <TableCell className="py-2 text-right font-mono text-xs text-fg-muted">
                    {event.duration ? `${event.duration}ms` : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

/**
 * The executions the server recorded (docs/CONTEXT.md §4.2): what the Queries and Stats tabs
 * read, in place of this browser's own history - which was the admin's, editable, and said
 * nothing about anyone else. The ring holds 1000 events, so that is the read's bound. The
 * request descriptor carries the refresh count so the Effect synchronises against a value it
 * reads (the OperationsAudit idiom above), rather than against a token it never touches.
 */
function useExecutionEvents() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshCount, setRefreshCount] = useState(0);
  const request = useMemo(() => ({ type: "query_execution", limit: 1000, refreshCount }), [refreshCount]);

  useEffect(() => {
    let ignore = false;
    loadAuditEvents(request.type, request.limit).then((next) => {
      if (ignore) return;
      setEvents(next);
      setLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, [request]);

  const refresh = () => {
    setLoading(true);
    setRefreshCount((c) => c + 1);
  };

  return { events, loading, refresh };
}

/** What the Queries tab can say about an execution's statement. */
function statementOf(event: AuditEvent): string | null {
  return event.details && event.details.length > 0 ? event.details : null;
}

function QueryAudit() {
  const { events, loading, refresh } = useExecutionEvents();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // The one row whose statement is unfolded, formatted (requested 2026-09-14).
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filteredEvents = useMemo(() => {
    let items = events;
    if (statusFilter !== "all") {
      const wanted = statusFilter === "error" ? "failure" : "success";
      items = items.filter((e) => e.result === wanted);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (e) =>
          (statementOf(e) ?? "").toLowerCase().includes(q) ||
          (e.connectionName || "").toLowerCase().includes(q) ||
          e.user.toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q),
      );
    }
    return items;
  }, [events, searchQuery, statusFilter]);

  const exportHistory = (format: "csv" | "json") => {
    let content: string;
    if (format === "csv") {
      const headers = [
        "Timestamp",
        "Action",
        "Statement",
        "Connection",
        "User",
        "Result",
        "Duration (ms)",
        "Reason",
        "IP",
        "ID",
      ];
      const rows = filteredEvents.map((event) =>
        csvRow([
          event.timestamp,
          event.action,
          statementOf(event) ?? "",
          event.connectionName ?? "",
          event.user,
          event.result,
          event.duration ?? "",
          event.reason ?? "",
          event.ip ?? "",
          event.id,
        ]),
      );
      content = [csvRow(headers), ...rows].join("\n");
    } else {
      content = jsonText(filteredEvents, 2);
    }
    downloadText(content, format === "csv" ? "text/csv" : "application/json", `query_history_${Date.now()}.${format}`);
  };

  const successCount = events.filter((e) => e.result === "success").length;
  const successRate = events.length > 0 ? Math.round((successCount / events.length) * 100) : 0;
  // The statement is recorded only under AUDIT_INCLUDE_SQL; say so once rather than per row.
  const statementsRecorded = events.some((e) => statementOf(e) !== null);

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[120px] h-8 text-xs bg-panel border-hairline-strong">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Search query..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-[200px] h-8 text-xs bg-panel border-hairline-strong"
        />
        <div className="text-xs text-fg-muted ml-auto">
          <span className="font-bold text-fg-secondary">{events.length}</span> queries
          <span className="mx-2">&middot;</span>
          <span className="text-success font-bold">{successRate}%</span> success
        </div>
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-2" onClick={refresh} disabled={loading}>
          <RefreshCw className="w-3 h-3" /> Refresh
        </Button>
        <AuditExport disabled={loading || filteredEvents.length === 0} onExport={exportHistory} />
      </div>

      {!loading && events.length > 0 && !statementsRecorded && (
        <p className="text-xs text-fg-muted" data-testid="statement-note">
          Statement text is not recorded. Set <code>AUDIT_INCLUDE_SQL=true</code> on the server to include it.
        </p>
      )}

      {/* Execution Table */}
      <div className="rounded-xl border border-hairline bg-panel overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-2">
            {["a", "b", "c"].map((row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-fg-subtle text-sm">
            <SearchIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No query history found.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-hairline hover:bg-transparent">
                <TableHead className="text-xs text-fg-muted font-bold uppercase w-[30px]" />
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Time</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Action</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase">Statement</TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden md:table-cell">
                  Connection
                </TableHead>
                <TableHead className="text-xs text-fg-muted font-bold uppercase hidden lg:table-cell">User</TableHead>
                <TableHead className="text-right text-xs text-fg-muted font-bold uppercase">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvents.slice(0, 200).map((event) => (
                <TableRow key={event.id} className="border-hairline hover:bg-fill">
                  <TableCell className="py-2">
                    {event.result === "success" ? (
                      <CircleCheck className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <CircleX className="w-3.5 h-3.5 text-danger" />
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-fg-muted whitespace-nowrap">
                    {new Date(event.timestamp).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge variant="outline" className="text-[0.625rem] font-bold border-hairline-strong">
                      {event.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2">
                    {statementOf(event) === null ? (
                      <span className="font-mono text-xs text-fg-subtle">not recorded</span>
                    ) : (
                      <div className="max-w-[250px] lg:max-w-[520px]">
                        <button
                          type="button"
                          className="flex items-start gap-1.5 text-left w-full font-mono text-xs text-fg-tertiary hover:text-fg"
                          onClick={() => setExpandedId((id) => (id === event.id ? null : event.id))}
                          aria-expanded={expandedId === event.id}
                          data-testid={`statement-toggle-${event.id}`}
                          title={event.reason ? `Failed: ${event.reason}` : undefined}
                        >
                          <ChevronRight
                            strokeWidth={1.5}
                            className={`w-3 h-3 mt-0.5 shrink-0 transition-transform ${expandedId === event.id ? "rotate-90" : ""}`}
                          />
                          <span className="truncate">{statementOverview(statementOf(event) ?? "")}</span>
                        </button>
                        {expandedId === event.id && (
                          <pre
                            className="mt-2 rounded-lg border border-hairline bg-sunken p-3 font-mono text-[11px] leading-relaxed text-fg-secondary whitespace-pre-wrap break-words max-h-96 overflow-auto"
                            data-testid={`statement-full-${event.id}`}
                          >
                            {formatStatement(statementOf(event) ?? "")}
                          </pre>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-fg-muted hidden md:table-cell truncate max-w-[100px]">
                    {event.connectionName || "-"}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-fg-muted hidden lg:table-cell">{event.user}</TableCell>
                  <TableCell className="py-2 text-right font-mono text-xs text-fg-muted">
                    {event.duration !== undefined ? `${event.duration}ms` : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function AuditStats() {
  const { events } = useExecutionEvents();
  const tooltipStyle = chartTooltipStyle(useEffectiveTheme());

  const stats = useMemo(() => {
    const total = events.length;
    const successful = events.filter((e) => e.result === "success").length;
    const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;
    const avgTime = total > 0 ? Math.round(events.reduce((sum, e) => sum + (e.duration ?? 0), 0) / total) : 0;

    const now = new Date();
    const byDay: { day: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfDay(subDays(now, i));
      const dayEnd = startOfDay(subDays(now, i - 1));
      const count = events.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      }).length;
      byDay.push({ day: format(dayStart, "EEE"), count });
    }

    // Most active datasources
    const freq: Record<string, { name: string; count: number }> = {};
    for (const e of events) {
      const key = e.connectionName || "(unnamed)";
      if (!freq[key]) freq[key] = { name: key, count: 0 };
      freq[key].count++;
    }
    const topConnections = Object.values(freq)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return { total, successful, successRate, avgTime, byDay, topConnections };
  }, [events]);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Total Queries</div>
          <div className="text-2xl font-bold text-fg tabular-nums">{stats.total}</div>
        </div>
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Success Rate</div>
          <div className="text-2xl font-bold text-success tabular-nums">{stats.successRate}%</div>
          <Progress value={stats.successRate} className="h-1 mt-2" />
        </div>
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Avg Duration</div>
          <div className="text-2xl font-bold text-fg tabular-nums">
            {stats.avgTime}
            <span className="text-sm text-fg-muted ml-1">ms</span>
          </div>
        </div>
        <div className="rounded-xl border border-hairline bg-panel p-4">
          <div className="text-xs text-fg-muted mb-1">Failed</div>
          <div className="text-2xl font-bold text-danger tabular-nums">{stats.total - stats.successful}</div>
        </div>
      </div>

      {/* Query Activity Chart */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-hairline bg-panel p-5">
          <h3 className="text-sm font-bold text-fg-secondary mb-4 flex items-center gap-2">
            <Activity className="h-4 w-4 text-brand" />
            Query Activity (7 days)
          </h3>
          {stats.total === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-fg-subtle">No query history yet.</div>
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byDay}>
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#71717a" }} axisLine={false} tickLine={false} />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "#71717a" }}
                    axisLine={false}
                    tickLine={false}
                    width={30}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Queries" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Most Active Connections */}
        <div className="rounded-xl border border-hairline bg-panel p-5">
          <h3 className="text-sm font-bold text-fg-secondary mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-brand" />
            Most Active Connections
          </h3>
          {stats.topConnections.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-fg-subtle">No data yet.</div>
          ) : (
            <div className="space-y-3">
              {stats.topConnections.map((tc) => {
                const pct = stats.total > 0 ? Math.round((tc.count / stats.total) * 100) : 0;
                return (
                  <div key={tc.name} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate max-w-[160px] text-fg-tertiary">{tc.name}</span>
                      <span className="text-fg-muted">
                        {tc.count} ({pct}%)
                      </span>
                    </div>
                    <Progress value={pct} className="h-1" />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
