"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApprovalsTab } from "@/components/admin/tabs/ApprovalsTab";

/**
 * The reviewer's page (docs/CONTEXT.md §4.19): the same approvals section the admin
 * dashboard has, reachable by anyone signed in, because a reviewer is whoever a
 * datasource's `approverRoles` names - a named role, a group - and need not administer.
 * The server lists only what this session may review; for everyone else the list is empty.
 */
export default function ApprovalsPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="border-b border-hairline bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="space-y-0.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-fg">Approvals</h1>
            <p className="text-xs text-fg-muted">
              Write requests waiting for you to review, on the datasources you review.
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
      <div data-testid="approvals-content" className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-6">
        <ApprovalsTab />
      </div>
    </div>
  );
}
