import { GcsError, gcsAccessToken as token, uploadToGcs as upload } from "@/lib/gcs";
import { BackupError } from "./errors";

/**
 * The bucket as the backups see it (docs/CONTEXT.md §4.14): the shared client in
 * `@/lib/gcs`, its errors answered as a BackupError with the same words and status, which
 * is what the backup routes and their callers already expect.
 */
function asBackupError(error: unknown): never {
  if (error instanceof GcsError) throw new BackupError(error.message, error.status);
  throw error;
}

export async function gcsAccessToken(): Promise<string> {
  return token().catch(asBackupError);
}

/** Upload `filePath` as `object` in `bucket`; the object's name is returned. */
export async function uploadToGcs(bucket: string, object: string, filePath: string): Promise<string> {
  return upload(bucket, object, { file: filePath }).catch(asBackupError);
}
