import { JobsTab } from "@/components/admin/tabs/JobsTab";

export default function AdminJobsPage() {
  return (
    <div data-testid="admin-content-jobs" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <JobsTab />
    </div>
  );
}
