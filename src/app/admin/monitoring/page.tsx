import { MonitoringEmbed } from "@/components/admin/tabs/MonitoringEmbed";

export default function AdminMonitoringPage() {
  return (
    <div data-testid="admin-content-monitoring" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <MonitoringEmbed />
    </div>
  );
}
