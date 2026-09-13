import { DatasourcesTab } from "@/components/admin/tabs/DatasourcesTab";
import { SshProfilesTab } from "@/components/admin/tabs/SshProfilesTab";

export default function AdminDatasourcesPage() {
  return (
    <div data-testid="admin-content-datasources" className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-10">
      <DatasourcesTab />
      <SshProfilesTab />
    </div>
  );
}
