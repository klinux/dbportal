"use client";

import { MonitoringDashboard } from "@/components/monitoring/MonitoringDashboard";

/** The monitoring dashboard inside the admin shell: the page provides the gutter, the dashboard the section header. */
export function MonitoringEmbed() {
  return (
    <div data-testid="monitoring-embed-root">
      <MonitoringDashboard isEmbedded />
    </div>
  );
}
