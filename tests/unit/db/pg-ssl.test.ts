import { describe, expect, test } from "bun:test";
import { splitPgUrl, sslFromMode } from "@/lib/db/pg-ssl";

/**
 * The sslmode of a PostgreSQL URL read here rather than by the driver (docs/CONTEXT.md
 * §4.47): the URL handed over carries no TLS parameter, the mode is read as libpq reads it,
 * the `ssl=` shorthand only when there is no mode, and a URL that is not one is untouched.
 */
describe("pg-ssl", () => {
  test("splits the TLS parameters off the URL and keeps the rest", () => {
    const split = splitPgUrl(
      "postgresql://u:p%40ss@DB.Example.com:5432/app?sslmode=Require&sslrootcert=/x.pem&uselibpqcompat=true&application_name=studio",
    );
    // The URL keeps the host as written (postgresql: is not a scheme the URL parser lower-cases);
    // the host field is lower-cased for the caller's own local-host rule.
    expect(split).toEqual({
      url: "postgresql://u:p%40ss@DB.Example.com:5432/app?application_name=studio",
      mode: "require",
      ssl: undefined,
      host: "db.example.com",
    });
    expect(splitPgUrl("postgresql://localhost/app?ssl=false")).toMatchObject({ url: "postgresql://localhost/app", ssl: false });
    expect(splitPgUrl("postgresql://localhost/app?ssl=1")).toMatchObject({ ssl: true });
    expect(splitPgUrl("postgresql://localhost/app?ssl=maybe")).toMatchObject({ ssl: undefined });
    // A mode wins over the shorthand; a bare URL names neither.
    expect(splitPgUrl("postgresql://h/app?ssl=true&sslmode=disable")).toMatchObject({ mode: "disable", ssl: undefined });
    expect(splitPgUrl("postgresql://h/app")).toEqual({ url: "postgresql://h/app", mode: undefined, ssl: undefined, host: "h" });
    // Not a URL: handed over as it is, with nothing read off it.
    expect(splitPgUrl("not a url")).toEqual({ url: "not a url", host: "" });
  });

  test("reads a mode as libpq does; an unknown one is nobody's decision", () => {
    expect(sslFromMode("disable")).toBe(false);
    for (const m of ["allow", "prefer", "require", "no-verify"]) expect(sslFromMode(m)).toEqual({ rejectUnauthorized: false });
    for (const m of ["verify-ca", "verify-full", "verify-system"]) expect(sslFromMode(m)).toEqual({ rejectUnauthorized: true });
    expect(sslFromMode(undefined)).toBeNull();
    expect(sslFromMode("whatever")).toBeNull();
  });
});
