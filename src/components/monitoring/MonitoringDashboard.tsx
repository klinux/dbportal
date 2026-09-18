"use client";

import { EnvironmentTag } from "@/components/EnvironmentTag";
import { useEnvironments } from "@/hooks/use-environments";
import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  LayoutDashboard,
  Clock,
  Users,
  Table2,
  HardDrive,
  RefreshCw,
  Play,
  Pause,
  Database,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ADMIN_SUBTAB_LIST_CLASS, ADMIN_SUBTAB_TRIGGER_CLASS } from "@/lib/ui/admin-tabs";
import { AdminSectionHeader } from "@/components/admin/AdminSectionHeader";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMonitoringData } from "@/hooks/use-monitoring-data";
import { storage } from "@/lib/storage";
import { useAllConnections } from "@/hooks/use-all-connections";
import { useProviderMetadata } from "@/hooks/use-provider-metadata";

import { OverviewTab } from "./tabs/OverviewTab";
import { PerformanceTab } from "./tabs/PerformanceTab";
import { QueriesTab } from "./tabs/QueriesTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { TablesTab } from "./tabs/TablesTab";
import { StorageTab } from "./tabs/StorageTab";
import { PoolTab } from "./tabs/PoolTab";

export function MonitoringDashboard() {
  const environments = useEnvironments();
  const router = useRouter();
  // The stored active connection is read once, at mount: it seeds the default
  // selection and nothing re-reads it afterwards. `readString` answers null
  // without a window, so the server render and the hydration render agree.
  const [savedId] = useState(() => storage.getActiveConnectionId());
  // Only what the user picked is state. The selection itself is derived below,
  // so it is right on the render the connection list first arrives.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  // Load connections (user + managed seed connections)
  const { connections: allConns } = useAllConnections();

  // Derived, not stored: an explicit pick wins, otherwise the saved active
  // connection, otherwise the first one. Resolving against the current list on
  // every render also means a connection that disappears from it stops being
  // selected, instead of leaving a dead object behind.
  const selectedConnection = useMemo(
    () =>
      chosenId !== null
        ? (allConns.find((c) => c.id === chosenId) ?? null)
        : (allConns.find((c) => c.id === savedId) ?? allConns[0] ?? null),
    [allConns, chosenId, savedId],
  );

  // Memoize options to prevent infinite re-renders
  const monitoringOptions = useMemo(
    () => ({
      includeTables: true,
      includeIndexes: true,
      includeStorage: true,
    }),
    [],
  );

  const {
    data,
    loading,
    error,
    lastUpdated,
    autoRefresh,
    refreshInterval,
    history,
    setAutoRefresh,
    setRefreshInterval,
    refresh,
    killSession,
    runMaintenance,
  } = useMonitoringData(selectedConnection, monitoringOptions);

  // Declared provider capabilities, so tabs can hide controls the provider cannot
  // perform (issue #272). Same hook Studio uses — no new API surface.
  const { metadata } = useProviderMetadata(selectedConnection);

  const handleConnectionChange = (connectionId: string) => {
    setChosenId(connectionId);
  };

  const formatLastUpdated = (date: Date | null) => {
    if (!date) return "Never";
    return date.toLocaleTimeString();
  };

  // The tabs carry no padding of their own: the page provides the gutter, so the content
  // only keeps its vertical rhythm.
  const tabContentClass = "m-0 p-0";

  const refreshControls = (
    <div className="flex items-center gap-1 sm:gap-2">
      <div className="hidden sm:flex items-center gap-2 text-xs text-fg-muted mr-2">
        <div className={`h-2 w-2 rounded-full ${autoRefresh ? "bg-hue-green-tint animate-pulse" : "bg-muted"}`} />
        <span className="hidden md:inline">{autoRefresh ? "Auto" : "Manual"}</span>
        <span className="hidden lg:inline text-xs">Last: {formatLastUpdated(lastUpdated)}</span>
      </div>

      {/* Interval selector */}
      <Select value={String(refreshInterval)} onValueChange={(v) => setRefreshInterval(Number(v))}>
        <SelectTrigger className="h-8 w-[80px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="5000">5s</SelectItem>
          <SelectItem value="10000">10s</SelectItem>
          <SelectItem value="15000">15s</SelectItem>
          <SelectItem value="30000">30s</SelectItem>
          <SelectItem value="60000">60s</SelectItem>
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setAutoRefresh(!autoRefresh)}
        title={autoRefresh ? "Pause auto-refresh" : "Start auto-refresh"}
      >
        {autoRefresh ? <Pause className="h-4 w-4" /> : <Play strokeWidth={1.5} className="h-4 w-4" />}
      </Button>

      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={refresh} disabled={loading} title="Refresh now">
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );

  const connectionSelect = (
    <Select value={selectedConnection?.id || ""} onValueChange={handleConnectionChange}>
      <SelectTrigger className="w-full sm:w-[280px] bg-panel border-hairline-strong text-fg-secondary">
        <SelectValue placeholder="Select connection">
          {selectedConnection ? (
            <div className="flex items-center gap-2">
              <Database strokeWidth={1.5} className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{selectedConnection.name}</span>
              <EnvironmentTag environment={selectedConnection.environment} environments={environments} />
              <span className="text-xs text-fg-muted hidden sm:inline">({selectedConnection.type})</span>
            </div>
          ) : (
            "Select connection"
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allConns.map((conn) => (
          <SelectItem key={conn.id} value={conn.id}>
            <div className="flex items-center gap-2">
              <Database strokeWidth={1.5} className="h-4 w-4" />
              <span>{conn.name}</span>
              <EnvironmentTag environment={conn.environment} environments={environments} />
              <span className="text-xs text-fg-muted">({conn.type})</span>
            </div>
          </SelectItem>
        ))}
        {allConns.length === 0 && <div className="px-2 py-1 text-xs text-fg-muted">No connections available</div>}
      </SelectContent>
    </Select>
  );

  // One layout wherever the dashboard is mounted: the section header every admin section
  // opens with, then the datasource, then the tabs. The page around it provides the gutter
  // (the admin shell, or src/app/monitoring/page.tsx's own shell on the standalone route).
  const header = (
    <>
      <AdminSectionHeader
        icon={Activity}
        title="Monitoring"
        description="Live metrics, queries, sessions, storage and the pool of one datasource, refreshed on the interval you pick."
        actions={refreshControls}
      />
      {connectionSelect}
    </>
  );

  return (
    <div className="space-y-6">
      {header}

      {/* Main Content */}
      {!selectedConnection ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-fg-muted">
          <Database strokeWidth={1.5} className="h-12 w-12" />
          <h2 className="text-lg font-medium">No Connection Selected</h2>
          <p className="text-xs">Select a database connection to view monitoring data.</p>
          <Button variant="outline" onClick={() => router.push("/")}>
            Manage Connections
          </Button>
        </div>
      ) : error && !data ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-destructive">
          <Activity strokeWidth={1.5} className="h-12 w-12" />
          <h2 className="text-lg font-medium">Connection Error</h2>
          <p className="text-xs">{error}</p>
          <Button variant="outline" onClick={refresh}>
            Try Again
          </Button>
        </div>
      ) : (
        <div>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
            {/* Tab Bar - Icon only on mobile, Icon + Text on desktop */}
            <div>
              <TabsList className={ADMIN_SUBTAB_LIST_CLASS}>
                <TabsTrigger value="overview" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Overview">
                  <LayoutDashboard strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Overview</span>
                </TabsTrigger>
                <TabsTrigger value="performance" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Performance">
                  <Activity strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Performance</span>
                </TabsTrigger>
                <TabsTrigger value="queries" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Queries">
                  <Clock strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Queries</span>
                </TabsTrigger>
                <TabsTrigger value="sessions" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Sessions">
                  <Users strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Sessions</span>
                </TabsTrigger>
                <TabsTrigger value="tables" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Tables">
                  <Table2 strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Tables</span>
                </TabsTrigger>
                <TabsTrigger value="storage" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Storage">
                  <HardDrive strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Storage</span>
                </TabsTrigger>
                <TabsTrigger value="pool" className={ADMIN_SUBTAB_TRIGGER_CLASS} title="Pool">
                  <Database strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span>Pool</span>
                </TabsTrigger>
              </TabsList>
            </div>

            <div>
              <TabsContent value="overview" className={tabContentClass}>
                <OverviewTab data={data} loading={loading} history={history} />
              </TabsContent>
              <TabsContent value="performance" className={tabContentClass}>
                <PerformanceTab data={data} loading={loading} history={history} />
              </TabsContent>
              <TabsContent value="queries" className={tabContentClass}>
                <QueriesTab data={data} loading={loading} labels={metadata?.labels} />
              </TabsContent>
              <TabsContent value="sessions" className={tabContentClass}>
                <SessionsTab data={data} loading={loading} onKillSession={killSession} labels={metadata?.labels} />
              </TabsContent>
              <TabsContent value="tables" className={tabContentClass}>
                <TablesTab
                  data={data}
                  loading={loading}
                  onRunMaintenance={runMaintenance}
                  capabilities={metadata?.capabilities}
                />
              </TabsContent>
              <TabsContent value="storage" className={tabContentClass}>
                <StorageTab data={data} loading={loading} />
              </TabsContent>
              <TabsContent value="pool" className={tabContentClass}>
                <PoolTab connection={selectedConnection} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      )}
    </div>
  );
}
