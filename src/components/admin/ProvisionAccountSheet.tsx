"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CONFIG_SHEET_CLASS } from "@/lib/ui/config-sheet";
import { KeyRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import type { ProvisionProfile } from "@/lib/provisioning/plan";
import type { InspectReport, ProvisionReport } from "@/lib/provisioning/run";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasource: { id: string; name: string; type: string } | null;
  /** Called after a completed run, so the list re-reads the datasource's new credential. */
  onProvisioned?: () => void;
}

/**
 * The portal's own database account, provisioned from the sheet (docs/CONTEXT.md §4.54).
 *
 * Three steps in one sheet - the frame every configuration editor opens in (§4.8), so the
 * plan and the report have a full column to scroll in and the list stays beside. On open, the datasource's own credential opens the database
 * and the schemas it holds are listed; the admin picks the profile, the schemas and
 * whether the agent gets its own read-only account, and may type a DBA credential for
 * this call alone. "Show the plan" answers every statement that would run, with the
 * password masked, and every blocker; "Provision" runs it and reports each statement's
 * outcome. The bootstrap credential typed here is sent with each call and kept nowhere;
 * a completed run clears it.
 */
export function ProvisionAccountSheet({ open, onOpenChange, datasource, onProvisioned }: Props) {
  const [profile, setProfile] = useState<ProvisionProfile>("read");
  const [available, setAvailable] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [agent, setAgent] = useState(false);
  const [bootstrapUser, setBootstrapUser] = useState("");
  const [bootstrapPassword, setBootstrapPassword] = useState("");
  const [vaultPath, setVaultPath] = useState("");
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InspectReport | null>(null);
  const [report, setReport] = useState<ProvisionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = (withSchemas: boolean) => ({
    profile,
    schemas: withSchemas ? schemas : [],
    agent,
    ...(bootstrapUser && bootstrapPassword ? { bootstrap: { user: bootstrapUser, password: bootstrapPassword } } : {}),
    ...(vaultPath.trim() ? { vaultPath: vaultPath.trim() } : {}),
  });

  const call = async (path: string, withSchemas: boolean) => {
    if (!datasource) return null;
    const res = await appFetch(`/api/admin/datasources/${encodeURIComponent(datasource.id)}/account${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(withSchemas)),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !(path === "" && typeof json.completed === "boolean")) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    return json;
  };

  // The schemas the database holds, read on open with the datasource's own credential.
  // Nothing is set synchronously here - the answer arrives.
  useEffect(() => {
    if (!open || !datasource) return;
    let cancelled = false;
    setInspection(null);
    setReport(null);
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        const answer = (await call("/plan", false)) as InspectReport;
        if (cancelled) return;
        setAvailable([...answer.inventory.availableSchemas]);
        setDefaultPath(
          answer.destination.kind === "store" ? null : `${answer.destination.mount}/${answer.destination.path}`,
        );
        // `public` is the schema a PostgreSQL database creates for everyone; the ordinary
        // starting point, and the admin unticks it where the app lives elsewhere.
        setSchemas(answer.inventory.availableSchemas.filter((name) => name === "public"));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The credential fields are deliberately not dependencies: a typed DBA credential is
    // used on the next explicit action, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, datasource?.id]);

  const close = (next: boolean) => {
    if (!next) {
      // The typed credential never survives the dialog.
      setBootstrapUser("");
      setBootstrapPassword("");
      setInspection(null);
      setReport(null);
      setError(null);
    }
    onOpenChange(next);
  };

  const inspect = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setInspection((await call("/plan", true)) as InspectReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = (await call("", true)) as ProvisionReport;
      setReport(answer);
      if (answer.completed) {
        setBootstrapUser("");
        setBootstrapPassword("");
        toast.success(`Account ${answer.roleName} provisioned`);
        onProvisioned?.();
      } else {
        toast.error("The plan stopped at a refused statement; see the report");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSchema = (name: string, on: boolean) =>
    setSchemas(on ? [...schemas.filter((s) => s !== name), name] : schemas.filter((s) => s !== name));

  const destinationText = (destination: InspectReport["destination"]) =>
    destination.kind === "store"
      ? "The password will be kept on the datasource record, sealed at rest (Vault is not configured)."
      : destination.kind === "vault"
        ? `The password will be written to Vault at ${destination.mount}/${destination.path} and the datasource pointed at it.`
        : `The password will be written to Vault at ${destination.mount}/${destination.path}; this datasource is declared in the seed file, so the file has to be pointed at the references the report will show.`;

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="provision-account-sheet">
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mb-6 pr-8">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                <KeyRound strokeWidth={1.5} className="w-5 h-5 text-brand" />
              </div>
              <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">
                The portal's own account on {datasource?.name ?? "the datasource"}
              </SheetTitle>
            </div>
            <SheetDescription className="text-xs text-fg-muted leading-relaxed">
              A least-privilege account for the portal, created with the datasource's current credential or one you type
              for this call. The plan is shown in full before anything runs; the password is generated and kept where
              the deployment keeps secrets, never shown.
            </SheetDescription>
          </div>

          <div className="space-y-4 text-xs">
            <fieldset className="space-y-2" data-testid="provision-profile">
              <Label className="text-fg-muted">Profile</Label>
              <div className="flex gap-4">
                {(["read", "readwrite"] as const).map((candidate) => (
                  <label key={candidate} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="provision-profile"
                      value={candidate}
                      checked={profile === candidate}
                      onChange={() => setProfile(candidate)}
                      aria-label={candidate === "read" ? "Read only" : "Read and write"}
                    />
                    <span>
                      {candidate === "read" ? "Read only (plus monitoring)" : "Read and write (DML, never DDL)"}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="space-y-2">
              <Label className="text-fg-muted">Schemas the account may reach</Label>
              {available.length === 0 ? (
                <p className="text-fg-muted" data-testid="provision-no-schemas">
                  {busy ? "Reading the database…" : "No schema was read yet."}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5" data-testid="provision-schemas">
                  {available.map((name) => (
                    <label key={name} className="flex items-center gap-2">
                      <Checkbox
                        checked={schemas.includes(name)}
                        onCheckedChange={(checked) => toggleSchema(name, checked === true)}
                        aria-label={`Schema ${name}`}
                      />
                      <span className="font-mono">{name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-center gap-2" htmlFor="provision-agent">
              <Checkbox
                id="provision-agent"
                checked={agent}
                onCheckedChange={(checked) => setAgent(checked === true)}
                aria-label="Agent account"
              />
              <span>Also create a read-only account for the agent (the agentUser of this datasource)</span>
            </label>

            <details className="rounded-md border border-hairline p-3">
              <summary className="cursor-pointer text-fg-muted">
                Bootstrap credential for this call (optional: the datasource&apos;s own is used otherwise)
              </summary>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div className="space-y-1">
                  <Label htmlFor="provision-bootstrap-user">DBA user</Label>
                  <Input
                    id="provision-bootstrap-user"
                    value={bootstrapUser}
                    onChange={(e) => setBootstrapUser(e.target.value)}
                    autoComplete="off"
                    className="h-9 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="provision-bootstrap-password">DBA password</Label>
                  <Input
                    id="provision-bootstrap-password"
                    type="password"
                    value={bootstrapPassword}
                    onChange={(e) => setBootstrapPassword(e.target.value)}
                    autoComplete="new-password"
                    className="h-9 text-xs"
                  />
                </div>
                {defaultPath !== null && (
                  <div className="space-y-1 md:col-span-2">
                    <Label htmlFor="provision-vault-path">
                      Vault path for the password (mount/path; keys user and password inside)
                    </Label>
                    <Input
                      id="provision-vault-path"
                      value={vaultPath}
                      onChange={(e) => setVaultPath(e.target.value)}
                      placeholder={defaultPath}
                      className="h-9 text-xs font-mono"
                    />
                    <p className="text-fg-muted">
                      Leave it empty for the default. Other keys the secret already holds are kept; a path where this
                      datasource&apos;s own credential lives under the same key is refused.
                    </p>
                  </div>
                )}
              </div>
              <p className="text-fg-muted mt-2">
                Used once and kept nowhere.{" "}
                {datasource?.type === "mysql"
                  ? "It needs CREATE USER and the privileges it will pass on WITH GRANT OPTION; on Cloud SQL the default user and every user made through the console have both."
                  : "On Cloud SQL, use the role that OWNS the tables: only the owner, or a member of it, can grant on them and bind the privileges of the tables to come."}
              </p>
            </details>

            {error && (
              <p className="text-status-danger" data-testid="provision-error">
                {error}
              </p>
            )}

            {inspection && (
              <div className="space-y-2" data-testid="provision-plan">
                <p className="text-fg-muted">
                  Bootstrap <span className="font-mono">{inspection.inventory.bootstrapUser}</span> on{" "}
                  <span className="font-mono">{inspection.inventory.database}</span>
                  {inspection.inventory.canCreateRole ? "" : " (cannot create accounts)"} · account{" "}
                  <span className="font-mono">{inspection.plan.roleName}</span>
                  {inspection.inventory.roleExists ? " exists, its password will be rotated" : " will be created"}
                </p>
                <p className="text-fg-muted">{destinationText(inspection.destination)}</p>
                {inspection.plan.blockers.length > 0 && (
                  <ul className="list-disc pl-4 text-status-danger space-y-1" data-testid="provision-blockers">
                    {inspection.plan.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                )}
                <pre className="rounded-md border border-hairline bg-sunken p-3 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                  {inspection.plan.statements
                    .map((s) => `-- ${s.purpose}${s.optional ? " (optional)" : ""}\n${s.shown};`)
                    .join("\n\n")}
                </pre>
              </div>
            )}

            {report && (
              <div className="space-y-2" data-testid="provision-report">
                <p className={report.completed ? "text-status-success" : "text-status-danger"}>
                  {report.completed
                    ? `Provisioned ${report.roleName}${report.agentRoleName ? ` and ${report.agentRoleName}` : ""}.`
                    : "The plan stopped; the statements below say where."}
                </p>
                <ul className="space-y-1 font-mono text-[11px]">
                  {report.statements.map((s) => (
                    <li
                      key={`${s.account}:${s.purpose}:${s.shown}`}
                      className={
                        s.outcome === "refused" ? "text-status-danger" : s.outcome === "skipped" ? "text-fg-muted" : ""
                      }
                    >
                      [{s.outcome}] {s.shown}
                      {s.error ? ` — ${s.error}` : ""}
                    </li>
                  ))}
                </ul>
                {report.references && (
                  <div className="space-y-1" data-testid="provision-references">
                    <p className="text-fg-muted">Point the seed file at these references:</p>
                    <pre className="rounded-md border border-hairline bg-sunken p-3 font-mono text-[11px]">
                      {`user: "${report.references.user}"\npassword: "${report.references.password}"${report.references.agentUser ? `\nagentUser: "${report.references.agentUser}"\nagentPassword: "${report.references.agentPassword}"` : ""}`}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => close(false)}
            data-testid="provision-close"
          >
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={inspect}
            disabled={busy || schemas.length === 0}
          >
            Show the plan
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={provision}
            disabled={busy || !inspection || inspection.plan.blockers.length > 0 || report?.completed === true}
          >
            {inspection?.inventory.roleExists ? "Rotate and apply" : "Provision"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
