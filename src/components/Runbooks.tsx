"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ListChecks, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Runbook, RunbookParam } from "@/lib/seed/types";

/**
 * The runbooks of the datasource open in the studio (docs/CONTEXT.md §4.20): pick one,
 * fill in what it asks for, run. The server binds the values and hands back the
 * statement in the engine's own placeholders; the run then goes through the ordinary
 * query path, naming the runbook on its audit line.
 */
export interface PreparedRunbook {
  sql: string;
  params: unknown[];
  runbook: string;
}

interface RunbooksProps {
  datasourceId?: string;
  onRun: (prepared: PreparedRunbook) => void;
}

function initialValues(runbook: Runbook): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of runbook.params ?? []) values[p.name] = p.default === undefined ? "" : String(p.default);
  return values;
}

function inputType(param: RunbookParam): string {
  return param.type === "number" ? "number" : "text";
}

export function Runbooks({ datasourceId, onRun }: RunbooksProps) {
  const [runbooks, setRunbooks] = useState<Runbook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Runbook | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preparing, setPreparing] = useState(false);

  const load = useCallback(
    () =>
      appFetch("/api/runbooks")
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { runbooks?: Runbook[]; error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setRunbooks(body.runbooks ?? []);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Runbooks could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const open = (runbook: Runbook) => {
    setChosen(runbook);
    setValues(initialValues(runbook));
  };

  const run = async () => {
    if (!chosen) return;
    setPreparing(true);
    try {
      const res = await appFetch(`/api/runbooks/${encodeURIComponent(chosen.id)}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const body = (await res.json().catch(() => ({}))) as { sql?: string; params?: unknown[]; error?: string };
      if (!res.ok || typeof body.sql !== "string")
        throw new Error(body.error ?? `The server refused the runbook (${res.status})`);
      onRun({ sql: body.sql, params: body.params ?? [], runbook: chosen.id });
      setChosen(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The runbook could not be prepared");
    } finally {
      setPreparing(false);
    }
  };

  const here = (runbooks ?? []).filter((r) => r.datasource === datasourceId);

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3" data-testid="runbooks">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-fg-secondary">
          <ListChecks strokeWidth={1.5} className="w-3.5 h-3.5 text-brand" />
          Runbooks
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5"
          onClick={() => load()}
          aria-label="Refresh runbooks"
        >
          <RefreshCw className="w-3 h-3" strokeWidth={1.75} />
          Refresh
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-status-danger" data-testid="runbooks-error">
          {error}
        </p>
      ) : !datasourceId ? (
        <p className="text-xs text-fg-muted" data-testid="runbooks-no-datasource">
          Open a shared datasource to see its runbooks.
        </p>
      ) : runbooks === null ? (
        <p className="text-xs text-fg-muted" data-testid="runbooks-loading">
          Loading…
        </p>
      ) : here.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="runbooks-empty">
          No runbook on this datasource. An administrator declares them on the Operations page.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {here.map((runbook) => (
            <li key={runbook.id}>
              <button
                type="button"
                className="w-full text-left rounded-lg border border-hairline bg-panel px-3 py-2 hover:border-hairline-strong"
                onClick={() => open(runbook)}
                data-testid={`runbook-${runbook.id}`}
              >
                <div className="text-xs font-medium text-fg-primary">{runbook.name}</div>
                {runbook.description && <div className="text-[11px] text-fg-muted">{runbook.description}</div>}
                <div className="font-mono text-[10px] text-fg-muted truncate">{runbook.sql}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={chosen !== null} onOpenChange={(next) => !preparing && !next && setChosen(null)}>
        <DialogContent data-testid="runbook-dialog">
          <DialogHeader>
            <DialogTitle className="text-sm">{chosen?.name}</DialogTitle>
            <DialogDescription className="text-xs">
              {chosen?.description ??
                "Fill in what the runbook asks for; the values are bound, never written into the statement."}
            </DialogDescription>
          </DialogHeader>
          <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-lg border border-hairline bg-panel p-2 text-fg-secondary max-h-40 overflow-auto">
            {chosen?.sql}
          </pre>
          <div className="space-y-3">
            {(chosen?.params ?? []).map((param) => (
              <div key={param.name} className="space-y-1.5">
                <Label htmlFor={`runbook-param-${param.name}`} className="text-xs text-fg-tertiary">
                  {param.label ?? param.name}
                  {param.required === false ? "" : " *"}
                </Label>
                {param.type === "boolean" ? (
                  <select
                    id={`runbook-param-${param.name}`}
                    value={values[param.name] ?? ""}
                    onChange={(e) => setValues({ ...values, [param.name]: e.target.value })}
                    className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs"
                  >
                    <option value="">—</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <Input
                    id={`runbook-param-${param.name}`}
                    type={inputType(param)}
                    value={values[param.name] ?? ""}
                    onChange={(e) => setValues({ ...values, [param.name]: e.target.value })}
                    className="h-8 text-xs bg-panel border-hairline-strong"
                  />
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setChosen(null)}
              disabled={preparing}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={run} disabled={preparing}>
              <Play className="w-3 h-3" strokeWidth={1.75} />
              Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
