"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MonitoringDashboard } from "@/components/monitoring/MonitoringDashboard";

/**
 * The studio's own route to monitoring: the same shell the admin dashboard has (a title
 * bar with the way back, then the page gutter) around the same dashboard the admin's
 * Monitoring section renders, so the two never drift apart.
 */
export default function MonitoringPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="border-b border-hairline bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="space-y-0.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-fg">Database Monitoring</h1>
            <p className="text-xs text-fg-muted">Live metrics of the datasources you can open.</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-hairline-strong text-fg-tertiary hover:text-fg"
            onClick={() => router.push("/")}
            aria-label="Back"
          >
            <ArrowLeft className="mr-2 h-3.5 w-3.5" />
            <span className="hidden sm:inline">Editor</span>
          </Button>
        </div>
      </header>
      <div data-testid="monitoring-content" className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-6">
        <MonitoringDashboard />
      </div>
    </div>
  );
}
