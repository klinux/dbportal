"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import type { SshIdentityView } from "@/lib/ssh-identity/store";

/**
 * A person's own SSH identity (docs/CONTEXT.md §4.9): the OS Login user and key an SSH
 * profile marked "personal identity" opens the bastion with, so the bastion's log names the
 * person. Typed once and never shown again - the dialog says a key is set and offers to
 * replace or remove it. Administrators only for now, which is where the dashboard puts it.
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SshIdentityDialog({ open, onOpenChange }: Props) {
  const [identity, setIdentity] = useState<SshIdentityView | null | undefined>(undefined);
  const [username, setUsername] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded on open; the typed secrets are cleared on close (below), never left in the
  // textarea for the next opening. Nothing is set synchronously here - the answer arrives.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch("/api/me/ssh-identity");
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const body = (await res.json()) as { identity: SshIdentityView | null };
        if (cancelled) return;
        setIdentity(body.identity);
        setUsername(body.identity?.username ?? "");
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = (next: boolean) => {
    if (!next) {
      setPrivateKey("");
      setPassphrase("");
      setError(null);
      setIdentity(undefined);
    }
    onOpenChange(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch("/api/me/ssh-identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          ...(privateKey.trim() ? { privateKey } : {}),
          ...(passphrase ? { passphrase } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { identity: SshIdentityView };
      setIdentity(body.identity);
      setPrivateKey("");
      setPassphrase("");
      toast.success("SSH identity saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch("/api/me/ssh-identity", { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setIdentity(null);
      setUsername("");
      toast.success("SSH identity removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSave = username.trim().length > 0 && (privateKey.trim().length > 0 || !!identity?.hasPrivateKey);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg" data-testid="ssh-identity-dialog">
        <DialogHeader>
          <DialogTitle>Your SSH identity</DialogTitle>
          <DialogDescription>
            The user and private key the bastions open for you, on the SSH profiles that ask for the
            person&apos;s own identity. The key is sealed on the server and never shown again; a profile
            without that option keeps using its shared credential.
          </DialogDescription>
        </DialogHeader>
        {identity === undefined && !error ? (
          <p className="text-xs text-fg-muted" data-testid="ssh-identity-loading">
            Loading…
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-fg-muted" data-testid="ssh-identity-state">
              {identity?.hasPrivateKey
                ? `A key is set for ${identity.username}${identity.hasPassphrase ? ", with a passphrase" : ""}. Leave the key blank to keep it.`
                : "No identity yet: the profiles that ask for one fall back to their shared credential for you."}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-identity-username" className="text-xs text-fg-tertiary">
                SSH username
              </Label>
              <Input
                id="ssh-identity-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your OS Login user, e.g. ana_example_com"
                className="h-8 text-xs font-mono bg-panel border-hairline-strong"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-identity-key" className="text-xs text-fg-tertiary">
                Private key
              </Label>
              <textarea
                id="ssh-identity-key"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder={
                  identity?.hasPrivateKey ? "Leave blank to keep the stored key" : "-----BEGIN OPENSSH PRIVATE KEY-----"
                }
                rows={6}
                spellCheck={false}
                className="w-full rounded-md border border-hairline-strong bg-panel px-3 py-2 text-xs font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-identity-passphrase" className="text-xs text-fg-tertiary">
                Passphrase (optional)
              </Label>
              <Input
                id="ssh-identity-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                className="h-8 text-xs bg-panel border-hairline-strong"
              />
            </div>
            {error && (
              <p className="text-xs text-status-danger" data-testid="ssh-identity-error">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          {identity?.hasPrivateKey && (
            <Button variant="outline" size="sm" onClick={remove} disabled={busy} className="text-xs">
              Remove identity
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={busy || !canSave} className="text-xs">
            Save identity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
