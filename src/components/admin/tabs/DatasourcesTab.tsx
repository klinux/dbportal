"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { ConnectionModal } from "@/components/ConnectionModal";
import { getDBConfig } from "@/lib/db-ui-config";
import {
  ENVIRONMENT_COLORS,
  type ConnectionEnvironment,
  type DatabaseConnection,
  type DatabaseType,
} from "@/lib/types";
import { Database, FileCode2, Pencil, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

/**
 * Shared datasources (docs/CONTEXT.md §4.1 step B): what an administrator declares once so
 * that everyone the roles name can open it. Grouped by ENVIRONMENT, because that is how an
 * operator thinks about a fleet - production is the list you read twice - and the seed
 * YAML's datasources are listed alongside the runtime ones, read-only, so this page shows
 * every shared datasource there is rather than only the ones it can edit.
 *
 * The editor is the connection modal the studio already has, with two things added around
 * it: who may open the datasource (roles) and, when editing, what the server holds for the
 * secret it never sends back. The modal tests the connection before it saves, and the
 * server resolves a `${ENV_VAR}` reference in that test, so a datasource can be saved with
 * the reference and never carry the value through the browser.
 */

type Role = "admin" | "user";
const ROLE_LABELS: Record<Role, string> = { admin: "Administrators", user: "Users" };

/**
 * Who may WRITE, as the editor offers it (docs/CONTEXT.md §4.4): everyone who can open
 * (no `writeRoles`), administrators only, or nobody. A rule the API or the seed file wrote
 * in another shape is shown as "custom" and kept as it is on save.
 */
type WriteMode = "open" | "admin" | "none" | "custom";
const WRITE_MODE_LABELS: Record<WriteMode, string> = {
  open: "Everyone who can open it",
  admin: "Administrators only",
  none: "Nobody - read-only datasource",
  custom: "Custom rule (kept as declared)",
};

export function writeModeOf(writeRoles: string[] | undefined): WriteMode {
  if (writeRoles === undefined) return "open";
  if (writeRoles.length === 0) return "none";
  if (writeRoles.length === 1 && writeRoles[0] === "admin") return "admin";
  return "custom";
}

/** The `group:<name>` principals of a rule, as the names the operator typed. */
export function groupNamesOf(rule: readonly string[]): string[] {
  return rule.filter((r) => r.startsWith("group:")).map((r) => r.slice("group:".length));
}

/** Comma- or space-separated group names, as principals; empty and duplicate names dropped. */
export function parseGroupNames(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((g) => g.trim())
        .filter(Boolean),
    ),
  ].map((g) => `group:${g}`);
}

const ENVIRONMENT_ORDER: ConnectionEnvironment[] = ["production", "staging", "development", "local", "other"];
const ENVIRONMENT_TITLES: Record<ConnectionEnvironment, string> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
  local: "Local",
  other: "Other",
};

interface StoreRow {
  source: "store";
  id: string;
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  environment?: ConnectionEnvironment;
  group?: string;
  color?: string;
  roles: string[];
  writeRoles?: string[];
  ssl?: DatabaseConnection["ssl"];
  serviceName?: string;
  instanceName?: string;
  localDataCenter?: string;
  authSource?: string;
  schema?: string;
  skipObjectScan?: boolean;
  hasPassword: boolean;
  passwordEnv?: string;
  hasConnectionString: boolean;
  updatedAt: string;
  updatedBy: string;
}

interface ConfigRow {
  source: "config";
  id: string;
  name: string;
  type: DatabaseType;
  environment?: ConnectionEnvironment;
  group?: string;
  roles: string[];
  writeRoles?: string[];
}

type Row = StoreRow | ConfigRow;

interface ListResponse {
  available: boolean;
  datasources: StoreRow[];
  declared: ConfigRow[];
}

/** The id a new datasource gets from its name: the seed schema's `[a-z0-9-]` shape. */
export function slugifyDatasourceId(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** What the API stores, from what the modal built: the connection fields the seed schema knows. */
export function toDatasourcePayload(
  conn: DatabaseConnection,
  id: string,
  roles: string[],
  writeRoles: string[] | undefined,
) {
  return {
    id,
    name: conn.name,
    type: conn.type,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    connectionString: conn.connectionString,
    environment: conn.environment,
    ssl: conn.ssl,
    serviceName: conn.serviceName,
    instanceName: conn.instanceName,
    localDataCenter: conn.localDataCenter,
    authSource: conn.authSource,
    schema: conn.schema,
    skipObjectScan: conn.skipObjectScan,
    roles,
    ...(writeRoles !== undefined ? { writeRoles } : {}),
  };
}

function rolesOf(row: Row): Role[] {
  return row.roles.includes("*")
    ? ["admin", "user"]
    : (row.roles.filter((r) => r === "admin" || r === "user") as Role[]);
}

function environmentOf(row: Row): ConnectionEnvironment {
  return row.environment ?? "other";
}

/** A store row as the modal edits it. The password is never known here; blank keeps the stored one. */
function toEditConnection(row: StoreRow): DatabaseConnection {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.user,
    password: "",
    environment: row.environment,
    color: row.color,
    group: row.group,
    ssl: row.ssl,
    serviceName: row.serviceName,
    instanceName: row.instanceName,
    localDataCenter: row.localDataCenter,
    authSource: row.authSource,
    schema: row.schema,
    skipObjectScan: row.skipObjectScan,
    createdAt: new Date(0),
    managed: true,
    seedId: row.id,
  };
}

async function fetchDatasources(): Promise<ListResponse> {
  const res = await appFetch("/api/admin/datasources");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return (await res.json()) as ListResponse;
}

function EnvironmentDot({ environment }: { environment: ConnectionEnvironment }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: ENVIRONMENT_COLORS[environment] }}
    />
  );
}

export function DatasourcesTab() {
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<StoreRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [roles, setRoles] = useState<Role[]>(["admin", "user"]);
  const [groupsInput, setGroupsInput] = useState("");
  const [writeMode, setWriteMode] = useState<WriteMode>("open");
  const [pendingDelete, setPendingDelete] = useState<StoreRow | null>(null);

  const applyListing = useCallback((body: ListResponse) => {
    setAvailable(body.available);
    setRows([...body.datasources, ...body.declared]);
  }, []);

  /**
   * Reads the list. The loading flag is raised by whoever asks for a read - the initial
   * state for the first one, the Refresh handler for a later one - and lowered when the
   * answer lands, so nothing here writes state synchronously from the mount effect.
   */
  const load = useCallback(
    () =>
      fetchDatasources()
        .then(applyListing)
        .catch((error: unknown) => {
          toast.error(`Could not load datasources: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => setLoading(false)),
    [applyListing],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setLoading(true);
    void load();
  };

  const groups = useMemo(() => {
    const byEnvironment = new Map<ConnectionEnvironment, Row[]>();
    for (const row of rows) {
      const env = environmentOf(row);
      byEnvironment.set(env, [...(byEnvironment.get(env) ?? []), row]);
    }
    return ENVIRONMENT_ORDER.filter((env) => byEnvironment.has(env)).map((env) => ({
      environment: env,
      rows: byEnvironment.get(env)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [rows]);

  const openCreate = () => {
    setEditing(null);
    setRoles(["admin", "user"]);
    setGroupsInput("");
    setWriteMode("open");
    setModalOpen(true);
  };

  const openEdit = (row: StoreRow) => {
    setEditing(row);
    setRoles(rolesOf(row));
    setGroupsInput(groupNamesOf(row.roles).join(", "));
    setWriteMode(writeModeOf(row.writeRoles));
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  const toggleRole = (role: Role, checked: boolean) => {
    setRoles((prev) => (checked ? [...new Set([...prev, role])] : prev.filter((r) => r !== role)));
  };

  /**
   * Called by the modal AFTER the connection test passed. The modal has no notion of roles or
   * of the id, so both are added here; the id of a new datasource is derived from its name.
   */
  const save = async (conn: DatabaseConnection) => {
    const openRule: string[] = [...roles, ...parseGroupNames(groupsInput)];
    if (openRule.length === 0) {
      toast.error("Choose at least one role or group that may open this datasource.");
      return;
    }
    const writeRule: string[] | undefined =
      writeMode === "open"
        ? undefined
        : writeMode === "admin"
          ? ["admin"]
          : writeMode === "none"
            ? []
            : editing?.writeRoles;
    const id = editing ? editing.id : slugifyDatasourceId(conn.name);
    if (!id) {
      toast.error("The name must contain at least one letter or digit.");
      return;
    }
    const payload = toDatasourcePayload(conn, id, openRule, writeRule);
    try {
      const res = await appFetch(
        editing ? `/api/admin/datasources/${encodeURIComponent(id)}` : "/api/admin/datasources",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success(editing ? `Datasource "${conn.name}" updated` : `Datasource "${conn.name}" created`);
      closeModal();
      await load();
    } catch (error) {
      toast.error(`Could not save datasource: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const remove = async (row: StoreRow) => {
    try {
      const res = await appFetch(`/api/admin/datasources/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success(`Datasource "${row.name}" deleted`);
      await load();
    } catch (error) {
      toast.error(`Could not delete datasource: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPendingDelete(null);
    }
  };

  const secretNote = editing
    ? editing.passwordEnv
      ? `The stored password references \${${editing.passwordEnv}} on the server. Leave the password blank to keep it.`
      : editing.hasPassword || editing.hasConnectionString
        ? "A credential is stored on the server and is never shown here. Leave the password blank to keep it."
        : "No credential is stored yet."
    : "Type the password, or a ${ENV_VAR} reference to a secret the server holds. It is tested before it is saved.";

  const sharingFields = (
    <div className="mb-6 rounded-xl border border-hairline bg-panel p-4 space-y-3" data-testid="datasource-sharing">
      <p className="text-xs font-medium text-fg-secondary">Who may open this datasource</p>
      <div className="flex flex-wrap gap-4">
        {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
          <Label key={role} className="flex items-center gap-2 text-xs text-fg-tertiary cursor-pointer">
            <Checkbox
              checked={roles.includes(role)}
              onCheckedChange={(checked) => toggleRole(role, checked === true)}
              aria-label={ROLE_LABELS[role]}
            />
            {ROLE_LABELS[role]}
          </Label>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="datasource-groups" className="text-xs text-fg-tertiary">
          Groups from the identity provider (comma-separated) that may also open it
        </Label>
        <Input
          id="datasource-groups"
          value={groupsInput}
          onChange={(e) => setGroupsInput(e.target.value)}
          placeholder="sre, data-platform"
          className="h-8 text-xs bg-panel border-hairline-strong"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="datasource-write-mode" className="text-xs text-fg-tertiary">
          Who may write
        </Label>
        <select
          id="datasource-write-mode"
          value={writeMode}
          onChange={(e) => setWriteMode(e.target.value as WriteMode)}
          className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs text-fg-secondary"
        >
          {(Object.keys(WRITE_MODE_LABELS) as WriteMode[])
            .filter((mode) => mode !== "custom" || writeMode === "custom")
            .map((mode) => (
              <option key={mode} value={mode}>
                {WRITE_MODE_LABELS[mode]}
              </option>
            ))}
        </select>
      </div>
      <p className="text-xs text-fg-muted leading-relaxed" data-testid="datasource-secret-note">
        {secretNote}
      </p>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-fg-secondary flex items-center gap-2">
            <Database className="h-4 w-4 text-brand" />
            Shared datasources
          </h2>
          <p className="text-xs text-fg-muted mt-1">
            Declared once, opened by everyone the roles name. Grouped by environment.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-2 bg-brand-solid hover:bg-brand-solid-hover text-white"
            onClick={openCreate}
            disabled={!available}
          >
            <Plus className="h-3 w-3" /> New datasource
          </Button>
        </div>
      </div>

      {!available && (
        <output className="flex items-start gap-3 rounded-xl border border-warning-tint/20 bg-warning-tint/5 p-4 text-xs text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <p className="leading-relaxed">
            Creating datasources here needs server storage: set <code>STORAGE_PROVIDER</code> to <code>sqlite</code> or{" "}
            <code>postgres</code>. Datasources declared in the seed file still work and are listed below.
          </p>
        </output>
      )}

      {loading ? (
        <div className="space-y-2" data-testid="datasources-loading">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline p-8 text-center text-xs text-fg-muted">
          No shared datasources yet. {available ? "Create the first one." : "Declare them in the seed file."}
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.environment} className="space-y-2" data-testid={`env-group-${group.environment}`}>
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-tertiary">
              <EnvironmentDot environment={group.environment} />
              {ENVIRONMENT_TITLES[group.environment]}
              <span className="font-normal text-fg-muted">({group.rows.length})</span>
            </h3>
            <div className="rounded-xl border border-hairline overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs">Engine</TableHead>
                    <TableHead className="text-xs">Target</TableHead>
                    <TableHead className="text-xs">Roles</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.map((row) => {
                    const engine = getDBConfig(row.type);
                    const Icon = engine.icon;
                    return (
                      <TableRow key={`${row.source}:${row.id}`} data-testid={`datasource-row-${row.id}`}>
                        <TableCell className="text-xs">
                          <div className="font-medium text-fg-secondary">{row.name}</div>
                          <div className="font-mono text-[10px] text-fg-muted">{row.id}</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <Icon className={`h-3.5 w-3.5 ${engine.color}`} aria-hidden="true" />
                            {engine.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs font-mono text-fg-tertiary">
                          {row.source === "store"
                            ? [row.host, row.port, row.database].filter(Boolean).length > 0
                              ? `${row.host ?? ""}${row.port ? `:${row.port}` : ""}${row.database ? `/${row.database}` : ""}`
                              : "—"
                            : "declared in seed file"}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap gap-1">
                            {rolesOf(row).map((role) => (
                              <Badge key={role} variant="outline" className="text-[10px]">
                                {ROLE_LABELS[role]}
                              </Badge>
                            ))}
                            {groupNamesOf(row.roles).map((group) => (
                              <Badge key={`group:${group}`} variant="outline" className="text-[10px] font-mono">
                                {group}
                              </Badge>
                            ))}
                            {row.writeRoles !== undefined && (
                              <Badge
                                variant="secondary"
                                className="text-[10px]"
                                title={row.writeRoles.join(", ") || "nobody"}
                              >
                                {writeModeOf(row.writeRoles) === "none" ? "read-only" : "writes restricted"}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.source === "config" ? (
                            <Badge variant="secondary" className="text-[10px] gap-1">
                              <FileCode2 className="h-3 w-3" /> seed file
                            </Badge>
                          ) : (
                            <span className="text-fg-muted" title={`Last change by ${row.updatedBy}`}>
                              {new Date(row.updatedAt).toLocaleDateString()} · {row.updatedBy}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.source === "store" ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                aria-label={`Edit ${row.name}`}
                                onClick={() => openEdit(row)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-danger hover:text-danger-bright"
                                aria-label={`Delete ${row.name}`}
                                onClick={() => setPendingDelete(row)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-fg-muted">read-only</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        ))
      )}

      <ConnectionModal
        isOpen={modalOpen}
        onClose={closeModal}
        onConnect={save}
        editConnection={editing ? toEditConnection(editing) : null}
        heading={{
          title: editing ? "Edit datasource" : "New datasource",
          description: editing
            ? "Update the shared datasource. It is tested before the change is saved."
            : "Declare a datasource everyone the roles name can open. It is tested before it is saved.",
        }}
        submitLabel={editing ? "Save datasource" : "Create datasource"}
        extraFields={sharingFields}
      />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete datasource?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" disappears from everyone's list. Nothing is changed on the database itself.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete && void remove(pendingDelete)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
