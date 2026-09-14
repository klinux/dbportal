import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { BackupError } from "./errors";

/**
 * One object upload to Google Cloud Storage (docs/CONTEXT.md §4.14), the way a production
 * backup leaves the pod: no client library, the JSON API's media upload with a bearer.
 * The token comes from GOOGLE_OAUTH_ACCESS_TOKEN when set (a developer's `gcloud auth
 * print-access-token`) and otherwise from the GKE metadata server, which is what Workload
 * Identity answers with - so in production nothing is configured but the bucket's name.
 */
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_TIMEOUT_MS = 2_000;

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
    throw new BackupError(
      "No Google Cloud credential: set GOOGLE_OAUTH_ACCESS_TOKEN or run with Workload Identity",
      503,
    );
  }
}

/** Upload `filePath` as `object` in `bucket`; the object's name is returned. */
export async function uploadToGcs(bucket: string, object: string, filePath: string): Promise<string> {
  const token = await gcsAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
      // A streamed request body needs this on every fetch that speaks HTTP/1.1.
      duplex: "half",
    } as RequestInit);
  } catch (error) {
    throw new BackupError(`The upload to the bucket failed: ${error instanceof Error ? error.name : "error"}`, 502);
  }
  if (!res.ok) throw new BackupError(`The bucket answered HTTP ${res.status}`, 502);
  return object;
}
