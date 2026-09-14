import { VaultError, listKvKeys, readKvSecret } from "./client";

/**
 * The Vault KV browser behind the datasource sheet (docs/CONTEXT.md §4.39, asked
 * 2026-09-14): an administrator walks the KV v2 mount the deployment names (VAULT_KV_MOUNT,
 * default `secret`), picks a secret, and the sheet is filled from it. What comes back is
 * shaped for the sheet, never the secret as a whole: host, port, user and database as
 * values (the fields anyone reads off the sheet), and the password and connection string as
 * `vault:kv:` references, so the credential itself never reaches the browser or the store -
 * it is read on the server when the datasource is opened, like any reference (§4.5).
 * Which key is which is read off its name; a secret with other names fills nothing and the
 * sheet says so.
 */
export const DEFAULT_KV_MOUNT = "secret";
const PATH_SHAPE = /^[A-Za-z0-9_\-./]*$/;

export function kvMount(): string {
  return process.env.VAULT_KV_MOUNT?.trim() || DEFAULT_KV_MOUNT;
}

/** A path under the mount: segments of plain characters, no `..`, no leading or doubled `/`. */
export function assertKvPath(path: string): string {
  if (!PATH_SHAPE.test(path) || path.startsWith("/") || path.includes("//") || path.split("/").includes("..")) {
    throw new VaultError("The Vault path is malformed", 400);
  }
  return path;
}

export interface KvListing {
  mount: string;
  path: string;
  folders: string[];
  secrets: string[];
}

export async function browseKv(path: string): Promise<KvListing> {
  const mount = kvMount();
  const clean = assertKvPath(path).replace(/\/$/, "");
  const keys = await listKvKeys(mount, clean);
  return {
    mount,
    path: clean,
    folders: keys.filter((k) => k.endsWith("/")).map((k) => k.slice(0, -1)),
    secrets: keys.filter((k) => !k.endsWith("/")),
  };
}

export type SheetField = "host" | "port" | "user" | "database";
export type SecretField = "password" | "connectionString";
const VALUE_KEYS: Record<SheetField, readonly string[]> = {
  host: ["host", "hostname", "server", "address", "endpoint"],
  port: ["port"],
  user: ["user", "username", "login", "db_user", "dbuser"],
  database: ["database", "db", "dbname", "db_name", "database_name"],
};
const SECRET_KEYS: Record<SecretField, readonly string[]> = {
  password: ["password", "pass", "pwd", "db_password", "dbpassword", "secret"],
  connectionString: ["url", "uri", "dsn", "connection_string", "connectionstring", "connection_url", "database_url"],
};

export interface SecretFields {
  path: string;
  /** Every key the secret has, by name only - so the sheet can say which were not understood. */
  keys: string[];
  fields: Partial<Record<SheetField, string>>;
  references: Partial<Record<SecretField, string>>;
}

function keyFor(names: string[], candidates: readonly string[]): string | undefined {
  return candidates.map((c) => names.find((n) => n.toLowerCase() === c)).find((n) => n !== undefined);
}

/** The secret at `path`, mapped onto the sheet: values for the plain fields, references for the secret ones. */
export async function secretFields(path: string): Promise<SecretFields> {
  const mount = kvMount();
  const clean = assertKvPath(path);
  if (!clean || clean.endsWith("/")) throw new VaultError("The Vault path names no secret", 400);
  const data = await readKvSecret(mount, clean);
  const keys = Object.keys(data);
  const fields: SecretFields["fields"] = {};
  for (const field of Object.keys(VALUE_KEYS) as SheetField[]) {
    const key = keyFor(keys, VALUE_KEYS[field]);
    const value = key === undefined ? undefined : data[key];
    if (typeof value === "string" || typeof value === "number") fields[field] = String(value);
  }
  const references: SecretFields["references"] = {};
  for (const field of Object.keys(SECRET_KEYS) as SecretField[]) {
    const key = keyFor(keys, SECRET_KEYS[field]);
    if (key !== undefined) references[field] = `vault:kv:${mount}/${clean}#${key}`;
  }
  return { path: clean, keys, fields, references };
}
