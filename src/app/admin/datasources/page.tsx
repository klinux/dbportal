import { DatasourcesTab } from "@/components/admin/tabs/DatasourcesTab";

export default function AdminDatasourcesPage() {
  return (
    <div data-testid="admin-content-datasources" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <DatasourcesTab />
    </div>
  );
}
