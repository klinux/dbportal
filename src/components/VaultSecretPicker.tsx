"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { appFetch } from "@/lib/config/base-path";
import type { KvListing, SecretFields } from "@/lib/vault/kv-browser";
import { ArrowLeft, FileKey, Folder, LoaderCircle, Vault } from "lucide-react";

/**
 * The Vault button on the datasource sheet (docs/CONTEXT.md §4.39): browse the KV mount,
 * pick a secret, and the sheet is filled from it - host, port, user and database as
 * values, the password as a `vault:kv:` reference the server resolves when the datasource
 * is opened. The credential itself never reaches the browser.
 */
export function VaultSecretPicker({ onPick }: { onPick: (fields: SecretFields) => void }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<KvListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failure = async (res: Response) =>
    ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Vault answered ${res.status}`;

  const browse = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(`/api/admin/vault/kv?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        setError(await failure(res));
        return;
      }
      setListing((await res.json()) as KvListing);
    } catch {
      setError("Vault could not be reached");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(`/api/admin/vault/kv?secret=${encodeURIComponent(path)}`);
      if (!res.ok) {
        setError(await failure(res));
        return;
      }
      const fields = (await res.json()) as SecretFields;
      if (Object.keys(fields.fields).length + Object.keys(fields.references).length === 0) {
        setError(`No key of that secret maps onto the sheet (keys: ${fields.keys.join(", ") || "none"})`);
        return;
      }
      onPick(fields);
      setOpen(false);
    } catch {
      setError("Vault could not be reached");
    } finally {
      setBusy(false);
    }
  };

  const parent = (path: string) => path.split("/").slice(0, -1).join("/");
  const join = (path: string, name: string) => (path ? `${path}/${name}` : name);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !listing) void browse("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-mediumr text-brand hover:text-brand-bright transition-colors px-2 py-1 rounded-md hover:bg-brand-tint/10"
          data-testid="vault-picker-open"
        >
          <Vault strokeWidth={1.5} className="w-3 h-3" />
          From Vault
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="vault-picker">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2 text-xs">
          <button
            type="button"
            className="text-fg-muted hover:text-fg disabled:opacity-40"
            onClick={() => listing && void browse(parent(listing.path))}
            disabled={busy || !listing || listing.path === ""}
            aria-label="Up one folder"
            data-testid="vault-picker-up"
          >
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
          <span className="font-mono truncate text-fg-secondary" data-testid="vault-picker-path">
            {listing ? `${listing.mount}/${listing.path}` : "…"}
          </span>
          {busy && <LoaderCircle className="w-3.5 h-3.5 animate-spin text-fg-muted ml-auto" />}
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {error && (
            <p className="px-3 py-2 text-xs text-danger" data-testid="vault-picker-error">
              {error}
            </p>
          )}
          {listing && !error && listing.folders.length + listing.secrets.length === 0 && (
            <p className="px-3 py-2 text-xs text-fg-muted">Nothing here.</p>
          )}
          {listing?.folders.map((name) => (
            <button
              key={`d:${name}`}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-fill disabled:opacity-40"
              onClick={() => void browse(join(listing.path, name))}
              disabled={busy}
              data-testid={`vault-folder-${name}`}
            >
              <Folder className="w-3.5 h-3.5 text-fg-muted" strokeWidth={1.75} />
              <span className="font-mono">{name}/</span>
            </button>
          ))}
          {listing?.secrets.map((name) => (
            <button
              key={`s:${name}`}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-fill disabled:opacity-40"
              onClick={() => void pick(join(listing.path, name))}
              disabled={busy}
              data-testid={`vault-secret-${name}`}
            >
              <FileKey className="w-3.5 h-3.5 text-brand" strokeWidth={1.75} />
              <span className="font-mono">{name}</span>
            </button>
          ))}
        </div>
        <p className="border-t border-hairline px-3 py-2 text-[11px] text-fg-muted">
          Host, port, user and database are copied; the password becomes a reference the server resolves.
        </p>
      </PopoverContent>
    </Popover>
  );
}
