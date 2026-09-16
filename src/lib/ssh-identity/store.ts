import { z } from "zod";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { SshIdentityRecord } from "@/lib/storage/types";

/**
 * A person's own SSH identity (docs/CONTEXT.md §4.9): the OS Login user and private key an
 * SSH profile marked `personalIdentity` opens the bastion with, so the bastion's own log
 * names the person rather than the profile's shared user. One document under the person's
 * own owner id in the server store, its secrets sealed by the same layer as a tunnel's;
 * typed once and never returned - the view says that a key is set and nothing of it. Kept
 * by administrators only today (the route decides that; the store does not care).
 */
export class SshIdentityError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SshIdentityError";
  }
}

const COLLECTION = "ssh_identity" as const;
const STORE_UNAVAILABLE = "An SSH identity needs server storage: set STORAGE_PROVIDER to sqlite or postgres";

const SshIdentityInput = z.object({
  username: z
    .string()
    .trim()
    .min(1, "the SSH username is required")
    .max(64)
    .regex(/^[a-z_][a-z0-9._-]*$/i, "the SSH username must be a Unix user name"),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
});

export interface SshIdentityView {
  username: string;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  updatedAt: string;
}

async function requireProvider() {
  if (!isServerStorageEnabled()) throw new SshIdentityError(STORE_UNAVAILABLE, 503);
  const provider = await getStorageProvider();
  if (!provider) throw new SshIdentityError(STORE_UNAVAILABLE, 503);
  return provider;
}

/** The person's identity, or null when they have none; null too without server storage. */
export async function getSshIdentity(owner: string): Promise<SshIdentityRecord | null> {
  if (!isServerStorageEnabled()) return null;
  const provider = await getStorageProvider();
  if (!provider) return null;
  const record = await provider.getCollection(owner, COLLECTION);
  return record && typeof record.privateKey === "string" && record.privateKey ? record : null;
}

/**
 * Save the person's identity. A key left blank keeps the stored one - the API never returns
 * it, so a round-tripped edit must not wipe it - and a first save needs one. A passphrase
 * left blank means none: it belongs to the key it was typed with.
 */
export async function putSshIdentity(owner: string, input: unknown): Promise<SshIdentityRecord> {
  const result = SshIdentityInput.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join("; ");
    throw new SshIdentityError(`Invalid SSH identity: ${issues}`, 400);
  }
  const provider = await requireProvider();
  const existing = await getSshIdentity(owner);
  const privateKey = result.data.privateKey?.trim() || existing?.privateKey;
  if (!privateKey) throw new SshIdentityError("Invalid SSH identity: a private key is required", 400);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new SshIdentityError("Invalid SSH identity: the private key is not in PEM form", 400);
  }
  const passphrase = result.data.passphrase?.trim() || (result.data.privateKey?.trim() ? undefined : existing?.passphrase);
  const record: SshIdentityRecord = {
    username: result.data.username,
    privateKey,
    ...(passphrase ? { passphrase } : {}),
    updatedAt: new Date().toISOString(),
  };
  await provider.setCollection(owner, COLLECTION, record);
  return record;
}

export async function deleteSshIdentity(owner: string): Promise<boolean> {
  const provider = await requireProvider();
  const existing = await getSshIdentity(owner);
  if (!existing) return false;
  await provider.setCollection(owner, COLLECTION, { username: "", privateKey: "", updatedAt: new Date().toISOString() });
  return true;
}

/** What leaves the server: the user name, that a key is set, never the key. */
export function toSshIdentityView(record: SshIdentityRecord): SshIdentityView {
  return {
    username: record.username,
    hasPrivateKey: !!record.privateKey,
    hasPassphrase: !!record.passphrase,
    updatedAt: record.updatedAt,
  };
}
