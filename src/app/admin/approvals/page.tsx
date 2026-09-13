import { ApprovalsTab } from "@/components/admin/tabs/ApprovalsTab";

export default function AdminApprovalsPage() {
  return (
    <div data-testid="admin-content-approvals" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <ApprovalsTab />
    </div>
  );
}
