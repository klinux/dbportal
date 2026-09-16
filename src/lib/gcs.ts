import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/**
 * Google Cloud Storage, as much of it as a file that must outlive the pod needs
 * (docs/CONTEXT.md §4.14, §4.46): one object written, one read back. No client library: the
 * JSON API with a bearer. The token comes from GOOGLE_OAUTH_ACCESS_TOKEN when set (a
 * developer's `gcloud auth print-access-token`) and otherwise from the GKE metadata server,
 * which is what Workload Identity answers with - so in production nothing is configured but
 * a bucket's name. Errors carry a status and never the token.
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

export async function gcsAccessToken(): Promise<string> {
  const fromEnv = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
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
    throw new GcsError("No Google Cloud credential: set GOOGLE_OAUTH_ACCESS_TOKEN or run with Workload Identity", 503);
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
