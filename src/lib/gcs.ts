import { createSign } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { Readable } from "node:stream";

/**
 * Google Cloud Storage, as much of it as a file that must outlive the pod needs
 * (docs/CONTEXT.md §4.14, §4.46): one object written, one read back. No client library: the
 * JSON API with a bearer. The token comes from GOOGLE_OAUTH_ACCESS_TOKEN when set (a
 * developer's `gcloud auth print-access-token`), else from a service account key named by
 * GOOGLE_APPLICATION_CREDENTIALS (a file, or the key's JSON itself, which is what a chart
 * hands over as a Secret without a volume) - the key signs a JWT that Google's token
 * endpoint exchanges for an hour's access token, kept until shortly before it expires - and
 * otherwise from the GKE metadata server, which is what Workload Identity answers with.
 * Errors carry a status and never the token or the key.
 */
export class GcsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GcsError";
  }
}

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_TIMEOUT_MS = 2_000;
const API = "https://storage.googleapis.com";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const TOKEN_LIFETIME_S = 3600;
/** A token is replaced this long before Google says it expires, so a request never carries a stale one. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const TOKEN_KEY = Symbol.for("dbportal.gcs-token");

interface TokenHolder {
  current: { email: string; token: string; expiresAt: number } | null;
  pending: Promise<string> | null;
}
function tokenHolder(): TokenHolder {
  const holder = globalThis as typeof globalThis & { [TOKEN_KEY]?: TokenHolder };
  holder[TOKEN_KEY] ??= { current: null, pending: null };
  return holder[TOKEN_KEY];
}
/** Tests only: forgets the exchanged token. */
export function resetGcsTokenCache(): void {
  const holder = tokenHolder();
  holder.current = null;
  holder.pending = null;
}

/** The service account key GOOGLE_APPLICATION_CREDENTIALS names, or null when it names none. */
function readServiceAccountKey(): ServiceAccountKey | null {
  const setting = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!setting) return null;
  let text = setting;
  if (!setting.startsWith("{")) {
    try {
      text = readFileSync(setting, "utf8");
    } catch {
      throw new GcsError("GOOGLE_APPLICATION_CREDENTIALS could not be read", 503);
    }
  }
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(text) as Partial<ServiceAccountKey>;
  } catch {
    throw new GcsError("GOOGLE_APPLICATION_CREDENTIALS is not a service account key", 503);
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new GcsError("GOOGLE_APPLICATION_CREDENTIALS is not a service account key", 503);
  }
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri };
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** The JWT the key signs (RS256), which the token endpoint accepts as the assertion. */
export function signServiceAccountJwt(key: ServiceAccountKey, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: STORAGE_SCOPE,
      aud: key.token_uri || DEFAULT_TOKEN_URI,
      iat,
      exp: iat + TOKEN_LIFETIME_S,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function exchangeKey(key: ServiceAccountKey): Promise<string> {
  const holder = tokenHolder();
  const now = Date.now();
  const c = holder.current;
  if (c && c.email === key.client_email && now < c.expiresAt - TOKEN_MARGIN_MS) return c.token;
  holder.pending ??= (async () => {
    const uri = key.token_uri || DEFAULT_TOKEN_URI;
    let res: Response;
    try {
      res = await fetch(uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signServiceAccountJwt(key),
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS * 5),
      });
    } catch (error) {
      throw new GcsError(`The token exchange for the service account failed: ${error instanceof Error ? error.name : "error"}`, 503);
    }
    if (!res.ok) throw new GcsError(`The service account key was refused: HTTP ${res.status}`, 503);
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new GcsError("The token exchange answered without an access token", 503);
    }
    const lifeS = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : TOKEN_LIFETIME_S;
    holder.current = { email: key.client_email, token: body.access_token, expiresAt: Date.now() + lifeS * 1000 };
    return body.access_token;
  })().finally(() => {
    holder.pending = null;
  });
  return holder.pending;
}

export async function gcsAccessToken(): Promise<string> {
  const fromEnv = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const key = readServiceAccountKey();
  if (key) return exchangeKey(key);
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("no access_token");
    return body.access_token;
  } catch {
    throw new GcsError(
      "No Google Cloud credential: set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_OAUTH_ACCESS_TOKEN, or run with Workload Identity",
      503,
    );
  }
}

/** What is uploaded: a file on disk, streamed, or content already in memory. */
export type GcsSource = { file: string } | { content: string | Buffer };

/** Upload `source` as `object` in `bucket`; the object's name is returned. */
export async function uploadToGcs(bucket: string, object: string, source: GcsSource): Promise<string> {
  const token = await gcsAccessToken();
  const url = `${API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      ...("file" in source
        ? {
            body: Readable.toWeb(createReadStream(source.file)) as unknown as BodyInit,
            // A streamed request body needs this on every fetch that speaks HTTP/1.1.
            duplex: "half",
          }
        : { body: source.content }),
    } as RequestInit);
  } catch (error) {
    throw new GcsError(`The upload to the bucket failed: ${error instanceof Error ? error.name : "error"}`, 502);
  }
  if (!res.ok) throw new GcsError(`The bucket answered HTTP ${res.status}`, 502);
  return object;
}

/** Read `object` from `bucket`; null when the bucket has no such object. */
export async function downloadFromGcs(bucket: string, object: string): Promise<Buffer | null> {
  const token = await gcsAccessToken();
  const url = `${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new GcsError(`The download from the bucket failed: ${error instanceof Error ? error.name : "error"}`, 502);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new GcsError(`The bucket answered HTTP ${res.status}`, 502);
  return Buffer.from(await res.arrayBuffer());
}

/** `gs://bucket/object` taken apart; null for anything else. */
export function parseGcsUri(uri: string): { bucket: string; object: string } | null {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  return m ? { bucket: m[1], object: m[2] } : null;
}
