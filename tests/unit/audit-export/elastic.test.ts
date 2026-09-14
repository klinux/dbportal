import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";

/**
 * The Elasticsearch audit exporter (docs/CONTEXT.md §4.12): off without a URL, batched by
 * size and by timer, sent as Bulk NDJSON with the event's id, retried with backoff and then
 * dropped with one warning, bounded in memory, and counted in the metrics registry.
 * Elasticsearch is a spied fetch.
 */
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, info: () => {}, error: () => {}, debug: () => {} } }));
const {
  DEFAULT_BATCH,
  DEFAULT_FLUSH_MS,
  DEFAULT_INDEX,
  MAX_ATTEMPTS,
  MAX_QUEUE,
  elasticConfig,
  enqueueAuditExport,
  flushAuditExport,
  resetAuditExport,
} = await import("@/lib/audit-export/elastic");
const { renderMetrics, resetMetrics } = await import("@/lib/metrics/registry");

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
const VARS = [
  "AUDIT_ELASTIC_URL",
  "AUDIT_ELASTIC_INDEX",
  "AUDIT_ELASTIC_API_KEY",
  "AUDIT_ELASTIC_BATCH",
  "AUDIT_ELASTIC_FLUSH_MS",
];
const saved: Record<string, string | undefined> = {};

const ok = (items: { status: number }[] = []) =>
  new Response(
    JSON.stringify({ errors: items.some((i) => i.status >= 300), items: items.map((i) => ({ create: i })) }),
    {
      status: 200,
    },
  );
const line = (id: string) => ({ id, event: "login_success", actor: "ana" });
const sentBodies = () => fetchSpy.mock.calls.map((c) => ((c as unknown[])[1] as RequestInit).body as string);

describe("elastic audit export", () => {
  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    process.env.AUDIT_ELASTIC_URL = "https://es.example.test/";
    process.env.AUDIT_ELASTIC_API_KEY = "key123";
    process.env.AUDIT_ELASTIC_BATCH = "3";
    process.env.AUDIT_ELASTIC_FLUSH_MS = "30";
    resetAuditExport();
    resetMetrics();
    warn.mockClear();
    fetchSpy = spyOn(holder, "fetch").mockImplementation(async () => ok());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetAuditExport();
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  test("the configuration: off without a URL; defaults for index, batch and flush; a trailing slash trimmed", () => {
    delete process.env.AUDIT_ELASTIC_URL;
    expect(elasticConfig()).toBeNull();
    process.env.AUDIT_ELASTIC_URL = "https://es.example.test///";
    delete process.env.AUDIT_ELASTIC_BATCH;
    process.env.AUDIT_ELASTIC_FLUSH_MS = "abc";
    delete process.env.AUDIT_ELASTIC_API_KEY;
    expect(elasticConfig()).toEqual({
      url: "https://es.example.test",
      index: DEFAULT_INDEX,
      batch: DEFAULT_BATCH,
      flushMs: DEFAULT_FLUSH_MS,
    });
    process.env.AUDIT_ELASTIC_INDEX = " audit-prod ";
    expect(elasticConfig()?.index).toBe("audit-prod");
  });

  test("off, enqueue and flush do nothing", async () => {
    delete process.env.AUDIT_ELASTIC_URL;
    enqueueAuditExport(line("1"));
    await flushAuditExport();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a full batch is sent at once as Bulk NDJSON with the id, the index and the ApiKey", async () => {
    enqueueAuditExport(line("a"));
    enqueueAuditExport(line("b"));
    expect(fetchSpy).not.toHaveBeenCalled();
    enqueueAuditExport(line("c"));
    await flushAuditExport();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://es.example.test/_bulk");
    expect(init.headers).toMatchObject({ "Content-Type": "application/x-ndjson", Authorization: "ApiKey key123" });
    const lines = (init.body as string).trimEnd().split("\n");
    expect(lines.length).toBe(6);
    expect(JSON.parse(lines[0])).toEqual({ create: { _index: "dbportal-audit", _id: "a" } });
    expect(JSON.parse(lines[1])).toEqual(line("a"));
    expect((init.body as string).endsWith("\n")).toBe(true);
    expect(renderMetrics()).toContain('dbportal_audit_export_total{outcome="shipped",sink="elastic"} 3');
  });

  test("a partial batch is sent when the timer fires; without an API key there is no Authorization header", async () => {
    delete process.env.AUDIT_ELASTIC_API_KEY;
    enqueueAuditExport(line("a"));
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  test("items Elasticsearch rejects are counted as failed and warned once; a 409 (already indexed) is a success", async () => {
    fetchSpy.mockImplementation(async () => ok([{ status: 201 }, { status: 409 }, { status: 400 }]));
    for (const id of ["a", "b", "c"]) enqueueAuditExport(line(id));
    await flushAuditExport();
    const text = renderMetrics();
    expect(text).toContain('dbportal_audit_export_total{outcome="shipped",sink="elastic"} 2');
    expect(text).toContain('dbportal_audit_export_total{outcome="failed",sink="elastic"} 1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a transport or HTTP failure is retried with backoff and then dropped with one warning", async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("busy", { status: 503 });
    });
    for (const id of ["a", "b", "c"]) enqueueAuditExport(line(id));
    const started = Date.now();
    await flushAuditExport();
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500 + 1000 - 50);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("HTTP 503");
    expect(renderMetrics()).toContain('dbportal_audit_export_total{outcome="failed",sink="elastic"} 3');
    // A failure on the first try only is one retry and a success.
    calls = 0;
    fetchSpy.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok();
    });
    enqueueAuditExport(line("d"));
    await flushAuditExport();
    expect(calls).toBe(2);
  }, 10_000);

  test("the queue is bounded: past MAX_QUEUE the oldest line is dropped and counted", async () => {
    process.env.AUDIT_ELASTIC_BATCH = String(MAX_QUEUE + 10);
    for (let i = 0; i < MAX_QUEUE + 2; i += 1) enqueueAuditExport(line(String(i)));
    expect(renderMetrics()).toContain('dbportal_audit_export_total{outcome="dropped",sink="elastic"} 2');
    await flushAuditExport();
    const body = sentBodies()[0];
    expect(body).not.toContain('"_id":"0"');
    expect(body).toContain('"_id":"2"');
  });

  test("a flush while one is in flight waits for it, then sends what arrived meanwhile", async () => {
    let release: () => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok());
        }),
    );
    for (const id of ["a", "b", "c"]) enqueueAuditExport(line(id));
    enqueueAuditExport(line("d"));
    const second = flushAuditExport();
    release();
    await second;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sentBodies()[1]).toContain('"_id":"d"');
  });
});
