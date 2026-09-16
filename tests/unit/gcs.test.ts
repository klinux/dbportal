import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  GcsError,
  downloadFromGcs,
  gcsAccessToken,
  parseGcsUri,
  resetGcsTokenCache,
  signServiceAccountJwt,
  uploadToGcs,
} from "@/lib/gcs";

/**
 * The shared Google Cloud Storage client (docs/CONTEXT.md §4.46): a token from the
 * environment or the metadata server, an upload from a file or from memory, a download that
 * is null for an object that is not there, and errors with a status and no token in them.
 * GCS is a spied fetch.
 */
type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
const savedToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
const savedKey = process.env.GOOGLE_APPLICATION_CREDENTIALS;
// A key pair made for the test, so a real signature is checked and no key ever sits in the repo.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = {
  type: "service_account",
  client_email: "dbportal@project.iam.gserviceaccount.com",
  private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  token_uri: "https://oauth2.example.test/token",
};
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("gcs client", () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "ya29.env-never-in-a-message";
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    resetGcsTokenCache();
    fetchSpy = spyOn(holder, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (savedToken === undefined) delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    else process.env.GOOGLE_OAUTH_ACCESS_TOKEN = savedToken;
    if (savedKey === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedKey;
  });

  test("the token comes from the environment, else the metadata server; neither answering is a 503", async () => {
    expect(await gcsAccessToken()).toBe("ya29.env-never-in-a-message");
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ access_token: "ya29.meta" }), { status: 200 }));
    expect(await gcsAccessToken()).toBe("ya29.meta");
    for (const answer of [
      async () => new Response("{}", { status: 200 }),
      async () => new Response("nope", { status: 404 }),
      async () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      fetchSpy.mockImplementation(answer);
      const err = await gcsAccessToken().catch((e) => e);
      expect(err).toBeInstanceOf(GcsError);
      expect(err.status).toBe(503);
    }
  });

  // The production shape on a cluster without Workload Identity: a key the chart hands over as
  // a Secret, signed into a JWT the token endpoint exchanges; the token kept until shortly
  // before it expires, one exchange at a time.
  test("a service account key, inline or as a file, is exchanged for a token that is kept and replaced before it expires", async () => {
    delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(KEY);
    let exchanges = 0;
    fetchSpy.mockImplementation(async () => {
      exchanges += 1;
      return new Response(JSON.stringify({ access_token: `ya29.k${exchanges}`, expires_in: 3600 }), { status: 200 });
    });
    const now = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const tokens = await Promise.all([gcsAccessToken(), gcsAccessToken()]);
      expect(tokens).toEqual(["ya29.k1", "ya29.k1"]);
      expect(exchanges).toBe(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://oauth2.example.test/token");
      expect(init.method).toBe("POST");
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [header, claims, signature] = form.get("assertion")!.split(".");
      expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decode(claims)).toEqual({
        iss: KEY.client_email,
        scope: "https://www.googleapis.com/auth/devstorage.read_write",
        aud: KEY.token_uri,
        iat: 1_700_000_000,
        exp: 1_700_000_000 + 3600,
      });
      // A real signature, checked with the pair's public key.
      const ok = createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(pair.publicKey, Buffer.from(signature, "base64url"));
      expect(ok).toBe(true);
      // Kept until five minutes before the hour is up, then exchanged again.
      now.mockReturnValue(1_700_000_000_000 + 54 * 60_000);
      expect(await gcsAccessToken()).toBe("ya29.k1");
      now.mockReturnValue(1_700_000_000_000 + 56 * 60_000);
      expect(await gcsAccessToken()).toBe("ya29.k2");
      // The same key from a file; a key without a token_uri asks Google's own endpoint.
      const dir = mkdtempSync(path.join(tmpdir(), "dbportal-gcs-key-"));
      try {
        const file = path.join(dir, "key.json");
        writeFileSync(file, JSON.stringify({ ...KEY, token_uri: undefined }));
        process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
        resetGcsTokenCache();
        expect(await gcsAccessToken()).toBe("ya29.k3");
        expect((fetchSpy.mock.calls[2] as unknown as [string])[0]).toBe("https://oauth2.googleapis.com/token");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // An explicit token still wins over the key.
      process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "ya29.given";
      expect(await gcsAccessToken()).toBe("ya29.given");
    } finally {
      now.mockRestore();
    }
  });

  test("a key that cannot be read, is not a key, is refused, or answers without a token is a 503 that never carries it", async () => {
    delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    const failing = async (): Promise<GcsError> => gcsAccessToken().catch((e) => e);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nowhere/key.json";
    expect((await failing()).message).toBe("GOOGLE_APPLICATION_CREDENTIALS could not be read");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "{not json";
    expect((await failing()).message).toBe("GOOGLE_APPLICATION_CREDENTIALS is not a service account key");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify({ client_email: KEY.client_email });
    expect((await failing()).message).toBe("GOOGLE_APPLICATION_CREDENTIALS is not a service account key");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(KEY);
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    let err = await failing();
    expect(err).toBeInstanceOf(GcsError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("The service account key was refused: HTTP 400");
    fetchSpy.mockImplementation(async () => new Response("<html>", { status: 200 }));
    expect((await failing()).message).toBe("The token exchange answered without an access token");
    fetchSpy.mockImplementation(async () => Promise.reject(new TypeError("fetch failed")));
    err = await failing();
    expect(err.message).toBe("The token exchange for the service account failed: TypeError");
    expect(JSON.stringify(err)).not.toContain("PRIVATE KEY");
    // The JWT alone, for a caller that wants to look at it: iat and exp from the clock it is given.
    const [, claims] = signServiceAccountJwt(KEY, 1_000_000).split(".");
    expect(decode(claims)).toMatchObject({ iat: 1000, exp: 4600 });
  });

  test("uploads from memory or from a file as a media upload under the object's name, with the bearer", async () => {
    expect(await uploadToGcs("b", "exports/j.csv", { content: "a,b" })).toBe("exports/j.csv");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit & { duplex?: string }];
    expect(url).toBe("https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=media&name=exports%2Fj.csv");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer ya29.env-never-in-a-message" });
    expect(init.body).toBe("a,b");
    expect(init.duplex).toBeUndefined();
    const dir = mkdtempSync(path.join(tmpdir(), "dbportal-gcs-"));
    try {
      const file = path.join(dir, "x.dump");
      writeFileSync(file, "dump");
      await uploadToGcs("b", "backups/x.dump", { file });
      const streamed = (fetchSpy.mock.calls[1] as unknown as [string, RequestInit & { duplex?: string }])[1];
      // A streamed body is a stream and says so, as HTTP/1.1 requires.
      expect(streamed.duplex).toBe("half");
      expect(typeof (streamed.body as ReadableStream).getReader).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bucket that refuses, and a transport failure, are a 502 without the token in the message", async () => {
    fetchSpy.mockImplementation(async () => new Response("denied", { status: 403 }));
    const refused = await uploadToGcs("b", "o", { content: "x" }).catch((e) => e);
    expect(refused).toBeInstanceOf(GcsError);
    expect(refused.status).toBe(502);
    expect(refused.message).toBe("The bucket answered HTTP 403");
    fetchSpy.mockImplementation(async () => Promise.reject(new TypeError("fetch failed")));
    const down = await uploadToGcs("b", "o", { content: "x" }).catch((e) => e);
    expect(down.message).toBe("The upload to the bucket failed: TypeError");
    expect(down.message).not.toContain("ya29");
  });

  test("downloads an object with the bearer; a missing one is null; a refusal or a failure is a 502", async () => {
    fetchSpy.mockImplementation(async () => new Response("a,b", { status: 200 }));
    expect((await downloadFromGcs("b", "exports/j.csv"))?.toString()).toBe("a,b");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://storage.googleapis.com/storage/v1/b/b/o/exports%2Fj.csv?alt=media");
    expect(init.headers).toEqual({ Authorization: "Bearer ya29.env-never-in-a-message" });
    fetchSpy.mockImplementation(async () => new Response("no such object", { status: 404 }));
    expect(await downloadFromGcs("b", "gone")).toBeNull();
    fetchSpy.mockImplementation(async () => new Response("denied", { status: 403 }));
    expect((await downloadFromGcs("b", "o").catch((e) => e)).status).toBe(502);
    fetchSpy.mockImplementation(async () => Promise.reject(new TypeError("fetch failed")));
    const down = await downloadFromGcs("b", "o").catch((e) => e);
    expect(down.message).toBe("The download from the bucket failed: TypeError");
  });

  test("a gs:// uri is taken apart; anything else is null", () => {
    expect(parseGcsUri("gs://my-bucket/exports/j.csv")).toEqual({ bucket: "my-bucket", object: "exports/j.csv" });
    expect(parseGcsUri("/data/exports/j.csv")).toBeNull();
    expect(parseGcsUri("gs://bucket-only")).toBeNull();
  });
});
