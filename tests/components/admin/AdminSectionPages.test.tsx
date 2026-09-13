import "../../setup-dom";
import { mock } from "bun:test";
import React from "react";

mock.module("@/components/admin/tabs/OperationsTab", () => ({
  OperationsTab: () => React.createElement("div", { "data-testid": "operations-tab" }, "OperationsTab"),
}));

mock.module("@/components/admin/tabs/MonitoringEmbed", () => ({
  MonitoringEmbed: () => React.createElement("div", { "data-testid": "monitoring-embed" }, "MonitoringEmbed"),
}));

mock.module("@/components/admin/tabs/SecurityTab", () => ({
  SecurityTab: () => React.createElement("div", { "data-testid": "security-tab" }, "SecurityTab"),
}));

mock.module("@/components/admin/tabs/AuditTab", () => ({
  AuditTab: () => React.createElement("div", { "data-testid": "audit-tab" }, "AuditTab"),
}));

mock.module("@/components/admin/tabs/DatasourcesTab", () => ({
  DatasourcesTab: () => React.createElement("div", { "data-testid": "datasources-tab" }, "DatasourcesTab"),
}));

mock.module("@/components/admin/tabs/SshProfilesTab", () => ({
  SshProfilesTab: () => React.createElement("div", { "data-testid": "ssh-profiles-tab" }, "SshProfilesTab"),
}));

mock.module("@/components/admin/tabs/ApprovalsTab", () => ({
  ApprovalsTab: () => React.createElement("div", { "data-testid": "approvals-tab" }, "ApprovalsTab"),
}));

const { default: AdminOperationsPage } = await import("@/app/admin/operations/page");
const { default: AdminMonitoringPage } = await import("@/app/admin/monitoring/page");
const { default: AdminSecurityPage } = await import("@/app/admin/security/page");
const { default: AdminAuditPage } = await import("@/app/admin/audit/page");
const { default: AdminDatasourcesPage } = await import("@/app/admin/datasources/page");
const { default: AdminApprovalsPage } = await import("@/app/admin/approvals/page");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

describe("Admin section pages", () => {
  afterEach(() => {
    cleanup();
  });

  // docs/CONTEXT.md §4.6: the reviewer's page.
  test("approvals page renders ApprovalsTab", () => {
    const { getByTestId } = render(<AdminApprovalsPage />);
    expect(getByTestId("admin-content-approvals")).not.toBeNull();
    expect(getByTestId("approvals-tab")).not.toBeNull();
  });

  test("operations page renders OperationsTab", () => {
    const { getByTestId } = render(<AdminOperationsPage />);
    expect(getByTestId("admin-content-operations")).not.toBeNull();
    expect(getByTestId("operations-tab")).not.toBeNull();
  });

  test("monitoring page renders MonitoringEmbed", () => {
    const { getByTestId } = render(<AdminMonitoringPage />);
    expect(getByTestId("admin-content-monitoring")).not.toBeNull();
    expect(getByTestId("monitoring-embed")).not.toBeNull();
  });

  test("security page renders SecurityTab", () => {
    const { getByTestId } = render(<AdminSecurityPage />);
    expect(getByTestId("admin-content-security")).not.toBeNull();
    expect(getByTestId("security-tab")).not.toBeNull();
  });

  test("datasources page renders DatasourcesTab", () => {
    const { getByTestId } = render(<AdminDatasourcesPage />);
    expect(getByTestId("admin-content-datasources")).not.toBeNull();
    expect(getByTestId("datasources-tab")).not.toBeNull();
    // docs/CONTEXT.md §4.9: the bastions live on the same page, below the datasources.
    expect(getByTestId("ssh-profiles-tab")).not.toBeNull();
  });

  test("audit page renders AuditTab", () => {
    const { getByTestId } = render(<AdminAuditPage />);
    expect(getByTestId("admin-content-audit")).not.toBeNull();
    expect(getByTestId("audit-tab")).not.toBeNull();
  });
});
