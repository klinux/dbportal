"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
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
import { CONFIG_SHEET_CLASS } from "@/lib/ui/config-sheet";
import { Pencil, Plus, RefreshCw, Terminal, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { SshProfileView } from "@/lib/ssh-profiles/types";

/**
 * SSH profiles (docs/CONTEXT.md §4.9): the bastions datasources are reached through,
 * declared once here (or in the seed file, read-only) and referenced by id from the
 * datasource editor. A secret is typed once and never shown again; the row says whether one
 * is set and, when it is a `${ENV_VAR}` or `vault:kv:` reference, which.
 */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface Draft {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: "password" | "privateKey";
  password: string;
  privateKey: string;
  passphrase: string;
  hostKeyFingerprint: string;
}

const EMPTY: Draft = {
  id: "",
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "privateKey",
  password: "",
  privateKey: "",
  passphrase: "",
  hostKeyFingerprint: "",
};

/** The id a new profile gets from its name: the schema's `[a-z0-9-]` shape. */
export function slugifyProfileId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The body a save sends: the fields, and a secret only when the operator typed one. */
export function toProfilePayload(draft: Draft, id: string) {
  return {
    id,
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port) || 22,
    username: draft.username.trim(),
    authMethod: draft.authMethod,
    ...(draft.authMethod === "password" && draft.password ? { password: draft.password } : {}),
    ...(draft.authMethod === "privateKey" && draft.privateKey ? { privateKey: draft.privateKey } : {}),
    ...(draft.authMethod === "privateKey" && draft.passphrase ? { passphrase: draft.passphrase } : {}),
    ...(draft.hostKeyFingerprint.trim() ? { hostKeyFingerprint: draft.hostKeyFingerprint.trim() } : {}),
  };
}

async function fetchProfiles(): Promise<SshProfileView[]> {
  const res = await appFetch("/api/admin/ssh-profiles");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { profiles: SshProfileView[] }).profiles;
}

export function SshProfilesTab() {
  const [profiles, setProfiles] = useState<SshProfileView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SshProfileView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SshProfileView | null>(null);

  const load = useCallback(
    () =>
      fetchProfiles()
        .then((list) => {
          setProfiles(list);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "SSH profiles could not be loaded")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY);
    setOpen(true);
  };

  const openEdit = (profile: SshProfileView) => {
    setEditing(profile);
    setDraft({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: String(profile.port),
      username: profile.username,
      authMethod: profile.authMethod,
      password: "",
      privateKey: "",
      passphrase: "",
      hostKeyFingerprint: profile.hostKeyFingerprint ?? "",
    });
    setOpen(true);
  };

  const save = async () => {
    const id = editing ? editing.id : slugifyProfileId(draft.name);
    if (!ID_SHAPE.test(id)) {
      toast.error("Give the profile a name with at least one letter or digit.");
      return;
    }
    if (!draft.host.trim() || !draft.username.trim()) {
      toast.error("Host and username are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await appFetch(
        editing ? `/api/admin/ssh-profiles/${encodeURIComponent(id)}` : "/api/admin/ssh-profiles",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toProfilePayload(draft, id)),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the profile (${res.status})`);
      toast.success(editing ? `SSH profile "${draft.name}" updated` : `SSH profile "${draft.name}" created`);
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The profile could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    try {
      const res = await appFetch(`/api/admin/ssh-profiles/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server refused the deletion (${res.status})`);
      toast.success(`SSH profile "${target.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The profile could not be deleted");
    } finally {
      setPendingDelete(null);
    }
  };

  const secretNote = editing
    ? editing.authMethod === "password"
      ? editing.passwordRef
        ? `The stored password references ${editing.passwordRef} on the server. Leave it blank to keep it.`
        : "A password is stored on the server and never shown here. Leave it blank to keep it."
      : editing.privateKeyRef
        ? `The stored key references ${editing.privateKeyRef} on the server. Leave it blank to keep it.`
        : "A private key is stored on the server and never shown here. Leave it blank to keep it."
    : "Type the secret, a ${ENV_VAR} reference, or a vault:kv:<mount>/<path>#<key> reference. It is sealed at rest.";

  return (
    <div className="space-y-4" data-testid="ssh-profiles">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-fg-primary flex items-center gap-2">
            <Terminal className="h-4 w-4 text-brand" strokeWidth={1.75} />
            SSH profiles
          </h2>
          <p className="text-xs text-fg-tertiary mt-1 max-w-2xl leading-relaxed">
            A bastion declared once. Datasources reference it by name and the server builds the tunnel when they open;
            the key never leaves the server.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs gap-2"
            onClick={() => load()}
            disabled={!profiles && !error}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
            Refresh
          </Button>
          <Button size="sm" className="h-8 text-xs gap-2" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            New profile
          </Button>
        </div>
      </div>

      {error && (
        <output className="flex items-center gap-2 text-xs text-status-danger" data-testid="ssh-profiles-error">
          <TriangleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </output>
      )}

      {!profiles && !error ? (
        <div className="space-y-2" data-testid="ssh-profiles-loading">
          <Skeleton className="h-8 w-full" />
        </div>
      ) : profiles && profiles.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="ssh-profiles-empty">
          No SSH profile yet. Declare one here or under <code>sshProfiles</code> in the seed file.
        </p>
      ) : profiles ? (
        <div className="border border-hairline rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs">Bastion</TableHead>
                <TableHead className="text-xs">Auth</TableHead>
                <TableHead className="text-xs">Host key</TableHead>
                <TableHead className="text-xs text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <TableRow key={profile.id} data-testid={`ssh-profile-${profile.id}`}>
                  <TableCell className="text-xs">
                    <div className="font-medium text-fg-primary">{profile.name}</div>
                    <div className="font-mono text-[10px] text-fg-muted">{profile.id}</div>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-fg-secondary">
                    {profile.username}@{profile.host}:{profile.port}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="text-[10px]">
                      {profile.authMethod === "password" ? "password" : "private key"}
                    </Badge>
                    {(profile.passwordRef || profile.privateKeyRef) && (
                      <span className="ml-2 font-mono text-[10px] text-fg-muted">
                        {profile.passwordRef ?? profile.privateKeyRef}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-fg-muted">
                    {profile.hostKeyFingerprint ? "pinned" : "trust on first use"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {profile.source === "config" ? (
                      <Badge
                        variant="secondary"
                        className="text-[10px]"
                        title="Declared in the seed file; edit it there"
                      >
                        seed file
                      </Badge>
                    ) : (
                      <div className="inline-flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => openEdit(profile)}
                          aria-label={`Edit ${profile.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-status-danger"
                          onClick={() => setPendingDelete(profile)}
                          aria-label={`Delete ${profile.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Sheet open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        {/* The same frame as the datasource editor: a padded, scrolling body and a footer that stays put. */}
        <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} data-testid="ssh-profile-sheet">
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="mb-6 pr-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
                  <Terminal strokeWidth={1.5} className="w-5 h-5 text-brand" />
                </div>
                <SheetTitle className="text-xs md:text-[0.8125rem] font-medium">
                  {editing ? "Edit SSH profile" : "New SSH profile"}
                </SheetTitle>
              </div>
              <SheetDescription className="text-xs text-fg-muted leading-relaxed">{secretNote}</SheetDescription>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ssh-name" className="text-xs text-fg-tertiary">
                  Name
                </Label>
                <Input
                  id="ssh-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Production bastion"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
                {!editing && draft.name && (
                  <p className="text-[11px] font-mono text-fg-muted">id: {slugifyProfileId(draft.name) || "—"}</p>
                )}
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div className="col-span-3 space-y-1.5">
                  <Label htmlFor="ssh-host" className="text-xs text-fg-tertiary">
                    Host
                  </Label>
                  <Input
                    id="ssh-host"
                    value={draft.host}
                    onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                    placeholder="bastion.example.com"
                    className="h-8 text-xs bg-panel border-hairline-strong"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ssh-port" className="text-xs text-fg-tertiary">
                    Port
                  </Label>
                  <Input
                    id="ssh-port"
                    value={draft.port}
                    onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                    className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-username" className="text-xs text-fg-tertiary">
                  Username
                </Label>
                <Input
                  id="ssh-username"
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  placeholder="ubuntu"
                  className="h-8 text-xs bg-panel border-hairline-strong"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-auth" className="text-xs text-fg-tertiary">
                  Authentication
                </Label>
                <select
                  id="ssh-auth"
                  value={draft.authMethod}
                  onChange={(e) => setDraft({ ...draft, authMethod: e.target.value as Draft["authMethod"] })}
                  className="h-8 w-full rounded-md border border-hairline-strong bg-panel px-2 text-xs text-fg-secondary"
                >
                  <option value="privateKey">Private key</option>
                  <option value="password">Password</option>
                </select>
              </div>
              {draft.authMethod === "password" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="ssh-password" className="text-xs text-fg-tertiary">
                    Password
                  </Label>
                  <Input
                    id="ssh-password"
                    type="password"
                    autoComplete="off"
                    value={draft.password}
                    onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                    placeholder={editing ? "Leave blank to keep the stored one" : "Password or ${BASTION_PASS}"}
                    className="h-8 text-xs bg-panel border-hairline-strong"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="ssh-key" className="text-xs text-fg-tertiary">
                      Private key
                    </Label>
                    <textarea
                      id="ssh-key"
                      value={draft.privateKey}
                      onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
                      placeholder={
                        editing
                          ? "Leave blank to keep the stored one"
                          : "-----BEGIN OPENSSH PRIVATE KEY----- … or ${BASTION_KEY}"
                      }
                      rows={5}
                      className="w-full rounded-md border border-hairline-strong bg-panel px-2 py-1.5 text-xs font-mono text-fg-secondary"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ssh-passphrase" className="text-xs text-fg-tertiary">
                      Passphrase (optional)
                    </Label>
                    <Input
                      id="ssh-passphrase"
                      type="password"
                      autoComplete="off"
                      value={draft.passphrase}
                      onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
                      className="h-8 text-xs bg-panel border-hairline-strong"
                    />
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="ssh-fingerprint" className="text-xs text-fg-tertiary">
                  Host key fingerprint (optional, pins the bastion)
                </Label>
                <Input
                  id="ssh-fingerprint"
                  value={draft.hostKeyFingerprint}
                  onChange={(e) => setDraft({ ...draft, hostKeyFingerprint: e.target.value })}
                  placeholder="SHA256:…"
                  className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                />
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-hairline bg-surface px-4 md:px-8 py-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving}>
              {editing ? "Save profile" : "Create profile"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SSH profile?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.name}&rdquo; will be removed. A profile a datasource still references cannot be
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
