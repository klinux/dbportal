"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ADMIN_SUBTAB_LIST_CLASS, ADMIN_SUBTAB_TRIGGER_CLASS } from "@/lib/ui/admin-tabs";
import { AlertsPanel } from "@/components/alerts/AlertsPanel";
import { ChannelsTab } from "@/components/admin/tabs/ChannelsTab";
import { BellRing, Radio } from "lucide-react";

/**
 * The alerts area (docs/CONTEXT.md §4.29, asked 2026-09-14): the alerts on one tab and the
 * channels they fire to on the next, so a person declares the Slack channel or the webhook
 * where they declare the alert, without an administrator in between.
 */
export function AlertsArea({ username }: { username?: string }) {
  return (
    <Tabs defaultValue="alerts">
      <TabsList className={ADMIN_SUBTAB_LIST_CLASS}>
        <TabsTrigger value="alerts" className={ADMIN_SUBTAB_TRIGGER_CLASS} data-testid="alerts-tab-alerts">
          <BellRing className="h-3.5 w-3.5" />
          Alerts
        </TabsTrigger>
        <TabsTrigger value="channels" className={ADMIN_SUBTAB_TRIGGER_CLASS} data-testid="alerts-tab-channels">
          <Radio className="h-3.5 w-3.5" />
          Channels
        </TabsTrigger>
      </TabsList>
      <TabsContent value="alerts" className="mt-4">
        <AlertsPanel />
      </TabsContent>
      <TabsContent value="channels" className="mt-4">
        <ChannelsTab scope="user" username={username} />
      </TabsContent>
    </Tabs>
  );
}
