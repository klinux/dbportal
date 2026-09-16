/**
 * The `sslmode` of a PostgreSQL URL, decided here rather than by the driver (docs/CONTEXT.md
 * §4.47). `pg` parses the URL it is given AFTER the explicit `ssl` config and lets the URL win,
 * and since pg-connection-string 2.7 a URL's `sslmode=require` turns verification ON - the
 * opposite of libpq, and of what the store and the datasource form promise. So the URL handed
 * to the driver carries no TLS parameter at all, and the mode read off it is mapped once:
 *
 *   disable                              no TLS
 *   allow, prefer, require, no-verify    TLS, the chain not checked (libpq's meaning of require)
 *   verify-ca, verify-full, verify-system TLS, the chain checked against the runtime's roots
 *
 * `verify-system` is this product's own spelling (the form's SSLMode), kept for the URLs
 * written in its vocabulary. A URL that does not parse is handed over untouched.
 */
const TLS_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslpassword", "uselibpqcompat"];

export type PgSslSetting = false | { rejectUnauthorized: boolean };

export interface SplitPgUrl {
  /** The URL without any TLS parameter, for the driver. */
  url: string;
  /** The `sslmode` the URL named, lower-cased; undefined when it named none. */
  mode?: string;
  /** The `ssl=` shorthand the URL named (`true`/`false`), when it named one and no `sslmode`. */
  ssl?: boolean;
  /** The host, lower-cased, for the caller's own local-host rule. */
  host: string;
}

export function splitPgUrl(connectionString: string): SplitPgUrl {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return { url: connectionString, host: "" };
  }
  const mode = parsed.searchParams.get("sslmode")?.trim().toLowerCase() || undefined;
  const sslParam = parsed.searchParams.get("ssl")?.trim().toLowerCase();
  const ssl =
    sslParam === undefined || mode
      ? undefined
      : ["true", "1", "yes"].includes(sslParam)
        ? true
        : ["false", "0", "no"].includes(sslParam)
          ? false
          : undefined;
  for (const p of TLS_PARAMS) parsed.searchParams.delete(p);
  return { url: parsed.toString(), mode, ssl, host: parsed.hostname.toLowerCase() };
}

/** What an `sslmode` means for the driver; null for a mode this reader does not know. */
export function sslFromMode(mode: string | undefined): PgSslSetting | null {
  switch (mode) {
    case "disable":
      return false;
    case "allow":
    case "prefer":
    case "require":
    case "no-verify":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
    case "verify-system":
      return { rejectUnauthorized: true };
    default:
      return null;
  }
}
