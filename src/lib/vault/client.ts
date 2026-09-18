import { readFileSync } from "node:fs";
import { Agent, type Dispatcher } from "undici";
import { logger } from "@/lib/logger";

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

/**
 * How the TLS connection to Vault is verified, for a Vault on an internal name whose
 * certificate the image's CA bundle does not know. The two settings are the Vault CLI's own:
 * `VAULT_CACERT` names the CA to trust (a PEM file, or the PEM text itself, which is what a
 * chart can hand over without a volume) and `VAULT_SKIP_VERIFY` turns verification off. Both
 * reach the Vault requests and nothing else - never the process-wide switch, which would also
 * strip verification from the identity provider and every database.
 */
export interface VaultTls {
  skipVerify: boolean;
  /** PEM text of the CA (or chain) to trust instead of the bundle; unset keeps the bundle. */
  ca?: string;
}

/**
 * How the client authenticates (docs/CONTEXT.md §4.5): a token it was given, or an AppRole
 * it logs in with - `VAULT_ROLE_ID` and `VAULT_SECRET_ID`, a secret id that need not
 * expire (`secret_id_ttl=0`, `secret_id_num_uses=0` on the role), against `auth/<mount>/login`
 * (`VAULT_APPROLE_MOUNT`, default `approle`). A token, when given, wins: it is what the
 * injector and Vault Agent leave behind, and they already renew it.
 */
export type VaultAuth =
  | { method: "token"; token: string }
  | { method: "approle"; mount: string; roleId: string; secretId: string };

export interface VaultConfig {
  addr: string;
  namespace?: string;
  timeoutMs: number;
  tls: VaultTls;
  auth: VaultAuth;
}

export const DEFAULT_VAULT_TIMEOUT_MS = 5_000;

export function isVaultConfigured(): boolean {
  return Boolean(process.env.VAULT_ADDR);
}

function readAuth(): VaultAuth {
  // A token file is what the Kubernetes injector and Vault Agent leave behind; read on every
  // call so a renewed file is picked up without a restart.
  const file = process.env.VAULT_TOKEN_FILE;
  if (file) {
    try {
      const token = readFileSync(file, "utf8").trim();
      if (token) return { method: "token", token };
    } catch {
      // Reported below as one message: an unreadable file and an empty one are the same to the caller.
    }
    throw new VaultError("VAULT_TOKEN_FILE could not be read or is empty");
  }
  const token = process.env.VAULT_TOKEN;
  if (token) return { method: "token", token };
  const roleId = process.env.VAULT_ROLE_ID?.trim();
  const secretId = process.env.VAULT_SECRET_ID?.trim();
  if (roleId && secretId) {
    return { method: "approle", mount: process.env.VAULT_APPROLE_MOUNT?.trim() || "approle", roleId, secretId };
  }
  throw new VaultError("VAULT_TOKEN, VAULT_TOKEN_FILE, or VAULT_ROLE_ID with VAULT_SECRET_ID is not set");
}

const ON = new Set(["true", "1", "yes", "on"]);
const OFF = new Set(["false", "0", "no", "off"]);

function readTls(): VaultTls {
  const skipVerify = ON.has((process.env.VAULT_SKIP_VERIFY ?? "").trim().toLowerCase());
  const setting = process.env.VAULT_CACERT?.trim();
  if (!setting) return { skipVerify };
  // The PEM itself, or the path of a file holding it; a file that cannot be read is refused
  // here rather than silently falling back to the bundle the operator meant to replace.
  if (setting.startsWith("-----BEGIN")) return { skipVerify, ca: setting };
  try {
    const ca = readFileSync(setting, "utf8").trim();
    if (ca) return { skipVerify, ca };
  } catch {
    // Reported below as one message, as the token file is.
  }
  throw new VaultError("VAULT_CACERT could not be read or is empty");
}

export function getVaultConfig(): VaultConfig {
  const addr = process.env.VAULT_ADDR;
  if (!addr) throw new VaultError("VAULT_ADDR is not set");
  const timeout = Number(process.env.VAULT_TIMEOUT_MS);
  return {
    addr: addr.replace(/\/+$/, ""),
    namespace: process.env.VAULT_NAMESPACE || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_VAULT_TIMEOUT_MS,
    tls: readTls(),
    auth: readAuth(),
  };
}

/**
 * The token an AppRole login produced, kept until 80% of its lease has passed (a lease of 0
 * is a token that does not expire) and then replaced by a new login - one code path, as the
 * database credentials are re-issued rather than renewed. On globalThis for the reason the
 * credential cache is: a Next.js module instance does not cross entries. One login at a time:
 * a burst of requests on an expired token shares the login in flight.
 */
interface VaultSession {
  key: string;
  token: string;
  obtainedAt: number;
  leaseMs: number;
}
/**
 * What is known about renewing a given token: whether Vault renews it at all (a periodic
 * token does, forever; the root token and a token without a TTL do not), and when the next
 * renewal is due - half the lease Vault answered with, or a minute after a failure.
 */
interface TokenRenewal {
  token: string;
  renewable: boolean;
  nextAt: number;
}
interface SessionHolder {
  current: VaultSession | null;
  pending: Promise<string> | null;
  renewal: TokenRenewal | null;
  renewing: Promise<void> | null;
}
const SESSION_KEY = Symbol.for("dbportal.vault-session");
const RELOGIN_AT = 0.8;
const RENEW_AT = 0.5;
export const RENEW_RETRY_MS = 60_000;

function sessionHolder(): SessionHolder {
  const holder = globalThis as typeof globalThis & { [SESSION_KEY]?: SessionHolder };
  holder[SESSION_KEY] ??= { current: null, pending: null, renewal: null, renewing: null };
  return holder[SESSION_KEY];
}

/** Drops the AppRole token and what is known about renewing a given one; a 403 does this, and tests. */
export function forgetVaultSession(): void {
  const holder = sessionHolder();
  holder.current = null;
  holder.renewal = null;
}

/**
 * `POST auth/token/renew-self` for the token the deployment was given, so a periodic token
 * (`vault token create -period=24h`) lives as long as the deployment does. Vault's answer
 * says when to come back: half of the new lease. A 400 or 403 is a token Vault does not
 * renew - the root token, one without a TTL, one already gone - and is not asked again;
 * anything else (Vault down, a timeout) is asked again in a minute. Never a throw: a
 * renewal that fails is a warning, and the request that prompted it goes on with the token
 * it has. `VAULT_TOKEN_RENEW=off` leaves the token to whoever supplied it (an injector).
 */
async function renewSelf(config: VaultConfig, token: string): Promise<TokenRenewal> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const dispatcher = vaultDispatcher(config.tls);
  const later = (renewable: boolean, nextAt: number): TokenRenewal => ({ token, renewable, nextAt });
  let res: Response;
  try {
    res = await fetch(`${config.addr}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: { "X-Vault-Token": token, ...(config.namespace ? { "X-Vault-Namespace": config.namespace } : {}) },
      signal: controller.signal,
      cache: "no-store",
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (error) {
    logger.warn("Vault token renewal failed", { route: "vault", error: error instanceof Error ? error.name : "error" });
    return later(true, Date.now() + RENEW_RETRY_MS);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 400 || res.status === 403) {
    logger.info("Vault token is not renewable; it will not be renewed", { route: "vault", status: res.status });
    return later(false, 0);
  }
  if (!res.ok) {
    logger.warn("Vault token renewal failed", { route: "vault", status: res.status });
    return later(true, Date.now() + RENEW_RETRY_MS);
  }
  let leaseS = 0;
  try {
    const body = (await res.json()) as { auth?: { lease_duration?: unknown } };
    leaseS =
      typeof body.auth?.lease_duration === "number" && body.auth.lease_duration > 0 ? body.auth.lease_duration : 0;
  } catch {
    // A renewal that answered 2xx without a readable lease: renewed, and asked again in a minute.
  }
  logger.info("Vault token renewed", { route: "vault", leaseS });
  return leaseS > 0 ? later(true, Date.now() + RENEW_AT * leaseS * 1000) : later(true, Date.now() + RENEW_RETRY_MS);
}

async function renewIfDue(config: VaultConfig, token: string): Promise<void> {
  if (OFF.has((process.env.VAULT_TOKEN_RENEW ?? "").trim().toLowerCase())) return;
  const holder = sessionHolder();
  const known = holder.renewal;
  if (known && known.token === token && (!known.renewable || Date.now() < known.nextAt)) return;
  holder.renewing ??= renewSelf(config, token)
    .then((renewal) => {
      holder.renewal = renewal;
    })
    .finally(() => {
      holder.renewing = null;
    });
  return holder.renewing;
}

async function loginAppRole(
  config: VaultConfig,
  auth: Extract<VaultAuth, { method: "approle" }>,
): Promise<VaultSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const dispatcher = vaultDispatcher(config.tls);
  let res: Response;
  try {
    res = await fetch(`${config.addr}/v1/auth/${auth.mount}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.namespace ? { "X-Vault-Namespace": config.namespace } : {}),
      },
      body: JSON.stringify({ role_id: auth.roleId, secret_id: auth.secretId }),
      signal: controller.signal,
      cache: "no-store",
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (error) {
    throw new VaultError(`Vault AppRole login failed: ${error instanceof Error ? error.name : "error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new VaultError(`Vault refused the AppRole login with ${res.status}`, res.status);
  let body: { auth?: { client_token?: unknown; lease_duration?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new VaultError("Vault answered the AppRole login with a body that is not JSON");
  }
  const token = body.auth?.client_token;
  if (typeof token !== "string" || !token) throw new VaultError("Vault answered the AppRole login without a token");
  const leaseS =
    typeof body.auth?.lease_duration === "number" && body.auth.lease_duration > 0 ? body.auth.lease_duration : 0;
  logger.info("Vault AppRole login", { route: "vault", mount: auth.mount, leaseS });
  return { key: `${config.addr}|${auth.mount}|${auth.roleId}`, token, obtainedAt: Date.now(), leaseMs: leaseS * 1000 };
}

/** The token a request presents: the one given, or the AppRole session's, logged in when due. */
export async function vaultToken(config: VaultConfig): Promise<string> {
  const auth = config.auth;
  if (auth.method === "token") {
    await renewIfDue(config, auth.token);
    return auth.token;
  }
  const holder = sessionHolder();
  const key = `${config.addr}|${auth.mount}|${auth.roleId}`;
  const s = holder.current;
  if (s && s.key === key && (s.leaseMs === 0 || Date.now() - s.obtainedAt < RELOGIN_AT * s.leaseMs)) return s.token;
  if (!holder.pending) {
    holder.pending = loginAppRole(config, auth)
      .then((session) => {
        holder.current = session;
        return session.token;
      })
      .finally(() => {
        holder.pending = null;
      });
  }
  return holder.pending;
}

let transport: { key: string; dispatcher: Dispatcher } | null = null;

/**
 * The dispatcher the Vault requests go through, or none when the default verification is
 * what was asked: an undici Agent whose connect options carry the CA or the skip, built once
 * per distinct setting and kept, so the pool it holds is reused. `fetch` in the Node runtime
 * the image runs honours `dispatcher`; the setting is logged once, as a warning when
 * verification is off, because a silent skip is the one an operator forgets to undo.
 */
export function vaultDispatcher(tls: VaultTls): Dispatcher | undefined {
  if (!tls.skipVerify && !tls.ca) return undefined;
  const key = `${tls.skipVerify}|${tls.ca ?? ""}`;
  if (transport?.key !== key) {
    transport = {
      key,
      dispatcher: new Agent({ connect: { ...(tls.ca ? { ca: tls.ca } : {}), rejectUnauthorized: !tls.skipVerify } }),
    };
    if (tls.skipVerify) logger.warn("Vault certificate verification is off (VAULT_SKIP_VERIFY)", { route: "vault" });
    else logger.info("Vault trusts the CA in VAULT_CACERT", { route: "vault" });
  }
  return transport.dispatcher;
}

/** Forgets the built dispatcher, so a test can watch it being built again. */
export function resetVaultTransport(): void {
  transport = null;
}

/**
 * One request to Vault, authenticated, bounded by the configured timeout, and retried
 * once after a new AppRole login when the token was refused. A write carries a JSON body;
 * a read carries none. A 204 (what a KV write answers under some policies) is an empty
 * object rather than a parse failure.
 */
async function vaultRequest(
  path: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
  retried = false,
): Promise<Record<string, unknown>> {
  const config = getVaultConfig();
  const token = await vaultToken(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res: Response;
  try {
    const dispatcher = vaultDispatcher(config.tls);
    res = await fetch(`${config.addr}/v1/${path}`, {
      method: init.method ?? "GET",
      headers: {
        "X-Vault-Token": token,
        ...(config.namespace ? { "X-Vault-Namespace": config.namespace } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
      cache: "no-store",
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (error) {
    // The error's own message may carry the URL; the name (AbortError, TypeError) says enough.
    throw new VaultError(`Vault request for ${path} failed: ${error instanceof Error ? error.name : "error"}`);
  } finally {
    clearTimeout(timer);
  }
  // An AppRole token Vault no longer accepts (revoked, or its lease ended early) is replaced
  // by one new login and the request tried once more; a second refusal is the answer.
  if (res.status === 403 && config.auth.method === "approle" && !retried) {
    forgetVaultSession();
    return vaultRequest(path, init, true);
  }
  if (!res.ok) throw new VaultError(`Vault answered ${res.status} for ${path}`, res.status);
  if (res.status === 204) return {};
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new VaultError(`Vault answered ${path} with a body that is not JSON`);
  }
}

function vaultGet(path: string): Promise<Record<string, unknown>> {
  return vaultRequest(path);
}

/**
 * Write the fields of a KV v2 secret: `POST <mount>/data/<path>` with `{ data }`, which
 * creates the secret or a new version of it. The one write this client makes, for the
 * account provisioning (docs/CONTEXT.md §4.54); the policy behind the token needs
 * `create` and `update` on that path and nothing wider. The cached copy of the secret, if
 * any, is the reader's to forget (`resetVaultCache`).
 */
export async function writeKvSecret(mount: string, path: string, data: Record<string, string>): Promise<void> {
  await vaultRequest(`${mount}/data/${path}`, { method: "POST", body: { data } });
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
