import { readFileSync } from "node:fs";

/**
 * The HashiCorp Vault HTTP API, as much of it as a datasource credential needs
 * (docs/CONTEXT.md §4.5): read one KV v2 secret, or have the database secrets engine issue
 * a credential with a lease. No client library: two GETs with a token header, a timeout,
 * and errors that name the path but never the token or the secret.
 */
export class VaultError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultConfig {
  addr: string;
  token: string;
  namespace?: string;
  timeoutMs: number;
}

export const DEFAULT_VAULT_TIMEOUT_MS = 5_000;

export function isVaultConfigured(): boolean {
  return Boolean(process.env.VAULT_ADDR);
}

function readToken(): string {
  // A token file is what the Kubernetes injector and Vault Agent leave behind; read on every
  // call so a renewed file is picked up without a restart.
  const file = process.env.VAULT_TOKEN_FILE;
  if (file) {
    try {
      const token = readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch {
      // Reported below as one message: an unreadable file and an empty one are the same to the caller.
    }
    throw new VaultError("VAULT_TOKEN_FILE could not be read or is empty");
  }
  const token = process.env.VAULT_TOKEN;
  if (!token) throw new VaultError("VAULT_TOKEN (or VAULT_TOKEN_FILE) is not set");
  return token;
}

export function getVaultConfig(): VaultConfig {
  const addr = process.env.VAULT_ADDR;
  if (!addr) throw new VaultError("VAULT_ADDR is not set");
  const timeout = Number(process.env.VAULT_TIMEOUT_MS);
  return {
    addr: addr.replace(/\/+$/, ""),
    token: readToken(),
    namespace: process.env.VAULT_NAMESPACE || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_VAULT_TIMEOUT_MS,
  };
}

async function vaultGet(path: string): Promise<Record<string, unknown>> {
  const config = getVaultConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${config.addr}/v1/${path}`, {
      headers: {
        "X-Vault-Token": config.token,
        ...(config.namespace ? { "X-Vault-Namespace": config.namespace } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    // The error's own message may carry the URL; the name (AbortError, TypeError) says enough.
    throw new VaultError(`Vault request for ${path} failed: ${error instanceof Error ? error.name : "error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new VaultError(`Vault answered ${res.status} for ${path}`, res.status);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new VaultError(`Vault answered ${path} with a body that is not JSON`);
  }
}

/** The fields of a KV v2 secret: `GET <mount>/data/<path>` → `.data.data`. */
export async function readKvSecret(mount: string, path: string): Promise<Record<string, unknown>> {
  const body = await vaultGet(`${mount}/data/${path}`);
  const data = (body.data as { data?: unknown } | undefined)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new VaultError(`Vault secret ${mount}/${path} has no data`);
  }
  return data as Record<string, unknown>;
}

/**
 * The keys under a KV v2 path: `LIST <mount>/metadata/<path>` (a GET with `?list=true`).
 * A folder ends with `/`. Nothing there is an empty list, not an error - Vault answers 404.
 */
export async function listKvKeys(mount: string, path: string): Promise<string[]> {
  const location = path ? `${mount}/metadata/${path}` : `${mount}/metadata`;
  let body: Record<string, unknown>;
  try {
    body = await vaultGet(`${location}?list=true`);
  } catch (error) {
    if (error instanceof VaultError && error.status === 404) return [];
    throw error;
  }
  const keys = (body.data as { keys?: unknown } | undefined)?.keys;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

export interface IssuedCredentials {
  username: string;
  password: string;
  leaseId: string;
  /** Seconds the credential lives, as Vault said; 0 when it did not say. */
  leaseDurationS: number;
}

/** A credential the database secrets engine creates: `GET <mount>/creds/<role>`. */
export async function issueDatabaseCredentials(mount: string, role: string): Promise<IssuedCredentials> {
  const body = await vaultGet(`${mount}/creds/${role}`);
  const data = body.data as Record<string, unknown> | undefined;
  if (typeof data?.username !== "string" || typeof data.password !== "string") {
    throw new VaultError(`Vault role ${mount}/creds/${role} answered without a username and password`);
  }
  return {
    username: data.username,
    password: data.password,
    leaseId: typeof body.lease_id === "string" ? body.lease_id : "",
    leaseDurationS: typeof body.lease_duration === "number" && body.lease_duration > 0 ? body.lease_duration : 0,
  };
}
