"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Database, Play, RefreshCw, Sprout } from "lucide-react";
import { toast } from "sonner";
import type { PlanTable } from "@/lib/seed-data/plan";
import type { SeedRun } from "@/lib/seed-data/run";

/**
 * Seeding a non-production datasource from its schema (docs/CONTEXT.md §4.23): read the
 * schema into a plan - the tables in the order they are filled, with what each depends on
 * and a row count to edit - then run it and watch each table fill. The server refuses what
 * it will not do (production, another engine, a freeze window); this panel shows its words.
 */
export const POLL_MS = 1500;

export function SeedDataPanel({ datasourceId, datasourceName }: { datasourceId: string; datasourceName: string }) {
  const [schema, setSchema] = useState("public");
  const [plan, setPlan] = useState<PlanTable[] | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [truncate, setTruncate] = useState(false);
  const [reading, setReading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<SeedRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The parent keys this panel by datasource, so a change of datasource is a fresh panel.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const readSchema = async () => {
    setReading(true);
    setError(null);
    try {
      const res = await appFetch("/api/admin/seed-data/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasourceId, schema }),
      });
      const body = (await res.json().catch(() => ({}))) as { tables?: PlanTable[]; error?: string };
      if (!res.ok || !body.tables) throw new Error(body.error ?? `The schema could not be read (${res.status})`);
      setPlan(body.tables);
      setCounts(Object.fromEntries(body.tables.map((t) => [t.name, String(t.rows)])));
      setRun(null);
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : "The schema could not be read");
    } finally {
      setReading(false);
    }
  };

  function poll(id: string): void {
    void appFetch(`/api/admin/seed-data/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { run?: SeedRun; error?: string };
        if (!res.ok || !body.run) throw new Error(body.error ?? `The run could not be read (${res.status})`);
        setRun(body.run);
        if (body.run.status === "running") timer.current = setTimeout(() => poll(id), POLL_MS);
        else
          toast[body.run.status === "done" ? "success" : "error"](
            `Seed ${body.run.status} on ${body.run.datasourceName}`,
          );
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "The run could not be read"));
  }

  const start = async () => {
    setConfirming(false);
    setError(null);
    try {
      const res = await appFetch("/api/admin/seed-data/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasourceId,
          schema,
          counts: Object.fromEntries(Object.entries(counts).map(([name, value]) => [name, Number(value)])),
          truncate,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { run?: SeedRun; error?: string };
      if (!res.ok || !body.run) throw new Error(body.error ?? `The seed was refused (${res.status})`);
      setRun(body.run);
      timer.current = setTimeout(() => poll(body.run!.id), POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The seed could not start");
    }
  };

  const total = plan ? plan.reduce((sum, t) => sum + (Number(counts[t.name]) || 0), 0) : 0;

  return (
    <div className="rounded-xl border border-hairline bg-panel p-4 space-y-3" data-testid="seed-data-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Sprout className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-bold text-fg-secondary">Seed from the schema</h3>
          <span className="text-xs text-fg-muted">on {datasourceName}</span>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="seed-schema" className="text-xs text-fg-tertiary">
            Schema
          </Label>
          <Input
            id="seed-schema"
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            className="h-8 w-32 text-xs font-mono bg-panel border-hairline-strong"
          />
          <Button size="sm" variant="outline" className="h-8 text-xs gap-2" onClick={readSchema} disabled={reading}>
            <Database className="h-3.5 w-3.5" strokeWidth={1.75} />
            {plan ? "Read again" : "Read schema"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-fg-muted">
        Generated rows, typed as the columns are, in the order the foreign keys need, so a staging datasource can carry
        the shape of production without its data. Never on production.
      </p>
      {error && (
        <p className="text-xs text-status-danger" data-testid="seed-data-error">
          {error}
        </p>
      )}
      {plan && (
        <div className="space-y-3">
          <div className="border border-hairline rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-fill-subtle text-fg-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Table</th>
                  <th className="text-left px-3 py-2 font-medium">After</th>
                  <th className="text-right px-3 py-2 font-medium">Rows</th>
                  <th className="text-right px-3 py-2 font-medium">Inserted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {plan.map((table) => {
                  const progress = run?.tables.find((t) => t.name === table.name);
                  return (
                    <tr key={table.name} data-testid={`seed-table-${table.name}`}>
                      <td className="px-3 py-1.5 font-mono text-fg-primary">
                        {table.name}
                        <span className="ml-2 text-[10px] text-fg-muted">{table.columns} cols</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-fg-muted">
                        {table.dependsOn.join(", ") || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Input
                          aria-label={`Rows for ${table.name}`}
                          inputMode="numeric"
                          value={counts[table.name] ?? ""}
                          onChange={(e) => setCounts({ ...counts, [table.name]: e.target.value })}
                          disabled={run?.status === "running"}
                          className="h-7 w-24 ml-auto text-right text-xs font-mono bg-panel border-hairline-strong"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                        {progress ? (
                          progress.error ? (
                            <span
                              className="text-status-danger"
                              title={progress.error}
                              data-testid={`seed-error-${table.name}`}
                            >
                              {progress.inserted} · failed
                            </span>
                          ) : (
                            <span
                              className={progress.inserted >= progress.target ? "text-success" : "text-fg-secondary"}
                            >
                              {progress.inserted} / {progress.target}
                            </span>
                          )
                        ) : (
                          <span className="text-fg-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Label className="flex items-center gap-2 text-xs text-fg-tertiary cursor-pointer">
              <Checkbox
                checked={truncate}
                onCheckedChange={(checked) => setTruncate(checked === true)}
                aria-label="Empty the tables first"
                disabled={run?.status === "running"}
              />
              Empty the tables first (TRUNCATE … RESTART IDENTITY CASCADE)
            </Label>
            <div className="flex items-center gap-2">
              {run && (
                <Badge
                  variant={run.status === "failed" ? "outline" : "secondary"}
                  className="text-[10px]"
                  data-testid="seed-status"
                >
                  {run.status}
                </Badge>
              )}
              {run?.status === "running" && (
                <Button variant="ghost" size="sm" className="h-8 text-xs gap-2" onClick={() => poll(run.id)}>
                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Refresh
                </Button>
              )}
              <Button
                size="sm"
                className="h-8 text-xs gap-2"
                onClick={() => setConfirming(true)}
                disabled={run?.status === "running" || total === 0}
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
                Seed {total.toLocaleString()} rows
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Seed {datasourceName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {total.toLocaleString()} generated rows go into {plan?.length ?? 0} tables of schema &ldquo;{schema}
              &rdquo;
              {truncate ? ", after every one of them is emptied" : ""}. This is written to the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={start}>Seed</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
