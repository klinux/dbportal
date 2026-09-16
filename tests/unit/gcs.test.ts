import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GcsError, downloadFromGcs, gcsAccessToken, parseGcsUri, uploadToGcs } from "@/lib/gcs";

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

describe("gcs client", () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "ya29.env-never-in-a-message";
    fetchSpy = spyOn(holder, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (savedToken === undefined) delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    else process.env.GOOGLE_OAUTH_ACCESS_TOKEN = savedToken;
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
