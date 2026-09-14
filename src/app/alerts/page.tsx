"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertsArea } from "@/components/alerts/AlertsArea";
import { useAuth } from "@/hooks/use-auth";

/**
 * The alerts page (docs/CONTEXT.md §4.29): the alerts this person keeps on the datasources
 * they may open - every one, for an administrator - and the editor that declares one.
 */
export default function AlertsPage() {
  const router = useRouter();
  const { user } = useAuth();
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="border-b border-hairline bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="space-y-0.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-fg">Alerts</h1>
            <p className="text-xs text-fg-muted">
              A read on a datasource, on a schedule, with a condition on what it returns; fires to a channel when it
              holds.
            </p>
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
      <div data-testid="alerts-content" className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-6">
        <AlertsArea username={user?.username} />
      </div>
    </div>
  );
}
