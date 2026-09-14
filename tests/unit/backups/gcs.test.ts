import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupError } from "@/lib/backups/errors";
import { gcsAccessToken, uploadToGcs } from "@/lib/backups/gcs";

/**
 * The bucket upload (docs/CONTEXT.md §4.14): the token from the environment or the
 * metadata server, the media upload with the object's name, and each failure as a
 * BackupError with a status and no credential in it. GCS is a spied fetch.
 */
type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
let dir = "";
let file = "";
const savedToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;

describe("gcs upload", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dbportal-gcs-"));
    file = path.join(dir, "x.dump");
    writeFileSync(file, "PGDMP");
    delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    fetchSpy = spyOn(holder, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    else process.env.GOOGLE_OAUTH_ACCESS_TOKEN = savedToken;
  });

  test("the token comes from the environment when set, else from the metadata server; neither answering is a 503", async () => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = " ya29.env ";
    expect(await gcsAccessToken()).toBe("ya29.env");
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ access_token: "ya29.meta" }), { status: 200 }),
    );
    expect(await gcsAccessToken()).toBe("ya29.meta");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("metadata.google.internal");
    expect(init.headers).toEqual({ "Metadata-Flavor": "Google" });
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 200 }));
    const err = await gcsAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.statusCode).toBe(503);
    fetchSpy.mockImplementation(async () => new Response("nope", { status: 404 }));
    expect((await gcsAccessToken().catch((e) => e)).statusCode).toBe(503);
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await gcsAccessToken().catch((e) => e)).statusCode).toBe(503);
  });

  test("uploads the file as a media upload under the object's name with the bearer", async () => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "ya29.env";
    expect(await uploadToGcs("acme backups", "dbportal/orders/a.dump", file)).toBe("dbportal/orders/a.dump");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit & { duplex?: string }];
    expect(url).toBe(
      "https://storage.googleapis.com/upload/storage/v1/b/acme%20backups/o?uploadType=media&name=dbportal%2Forders%2Fa.dump",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer ya29.env", "Content-Type": "application/octet-stream" });
    expect(init.duplex).toBe("half");
    expect(init.body).toBeDefined();
  });

  test("a bucket that refuses, and a transport failure, are a 502 without the token in the message", async () => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "ya29.secret";
    fetchSpy.mockImplementation(async () => new Response("denied", { status: 403 }));
    let err = await uploadToGcs("b", "o", file).catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("HTTP 403");
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    err = await uploadToGcs("b", "o", file).catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("TypeError");
    expect(err.message).not.toContain("ya29");
  });
});
