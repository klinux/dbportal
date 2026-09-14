"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TRAIL_RULES, TRAIL_RULE_LABELS, type TrailAlertsConfig, type TrailRule } from "@/lib/trail-alerts/types";
import { Save, Siren } from "lucide-react";
import { toast } from "sonner";

/**
 * Alerts on the trail (docs/CONTEXT.md §4.32): for each of the four rules, the channels it
 * fires to, and how many rows make an export large. Saved as one document by an
 * administrator; nothing fires until a channel is ticked.
 */
export function TrailAlertsCard({ channels }: { channels: { id: string; name: string }[] }) {
  const [config, setConfig] = useState<TrailAlertsConfig | null>(null);
  const [threshold, setThreshold] = useState("1000");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    appFetch("/api/admin/trail-alerts")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const body = (await res.json()) as { trailAlerts: TrailAlertsConfig };
        if (ignore) return;
        setConfig(body.trailAlerts);
        setThreshold(String(body.trailAlerts.exportRowsThreshold));
      })
      .catch((err: unknown) => {
        if (!ignore) toast.error(err instanceof Error ? err.message : "Trail alerts could not be loaded");
      });
    return () => {
      ignore = true;
    };
  }, []);

  // The boxes exist only once the rules are loaded, so `c` is never null here.
  const toggle = (rule: TrailRule, id: string) =>
    setConfig((c) => {
      const current = c as TrailAlertsConfig;
      const ticked = current.rules[rule].includes(id);
      return {
        ...current,
        rules: {
          ...current.rules,
          [rule]: ticked ? current.rules[rule].filter((x) => x !== id) : [...current.rules[rule], id],
        },
      };
    });

  const save = async () => {
    if (!config) return;
    const rows = Number(threshold);
    if (!Number.isInteger(rows) || rows < 1) {
      toast.error("The export threshold must be a whole number of rows, at least 1.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch("/api/admin/trail-alerts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, exportRowsThreshold: rows }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the rules (${res.status})`);
      toast.success("Trail alerts saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The trail alerts could not be saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-hairline bg-panel p-4 space-y-3" data-testid="trail-alerts">
      <div className="flex items-center gap-2">
        <Siren className="h-4 w-4 text-brand" strokeWidth={1.75} />
        <h3 className="text-sm font-bold text-fg-secondary">Alerts on the trail</h3>
      </div>
      <p className="text-xs text-fg-muted">
        What the audit trail says that someone should hear at once. Each rule fires to the channels ticked, once per
        datasource every five minutes at most.
      </p>
      {!config ? (
        <p className="text-xs text-fg-muted" data-testid="trail-alerts-loading">
          Loading…
        </p>
      ) : (
        <div className="space-y-3">
          {TRAIL_RULES.map((rule) => (
            <div key={rule} className="space-y-1" data-testid={`trail-rule-${rule}`}>
              <p className="text-xs text-fg-tertiary">{TRAIL_RULE_LABELS[rule]}</p>
              {channels.length === 0 ? (
                <p className="text-[11px] text-fg-muted">No channel declared yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {channels.map((channel) => (
                    <label key={channel.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.rules[rule].includes(channel.id)}
                        onChange={() => toggle(rule, channel.id)}
                        aria-label={`${TRAIL_RULE_LABELS[rule]}: ${channel.id}`}
                      />
                      {channel.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="trail-export-threshold" className="text-xs text-fg-tertiary">
                Rows that make an export large
              </Label>
              <Input
                id="trail-export-threshold"
                inputMode="numeric"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="h-8 w-40 text-xs font-mono bg-panel border-hairline-strong"
              />
            </div>
            <Button size="sm" className="h-8 text-xs gap-2" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
              Save trail alerts
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
