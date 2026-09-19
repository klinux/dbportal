import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { JobRecord } from "@/lib/storage/types";

/**
 * The export route (docs/CONTEXT.md §4.22, §4.40): the session, the statement and the form
 * checked, the datasource's rule first and audited when it refuses, only a read; then the
 * export handed to the queue and the file streamed when the worker finished within the
 * wait, or 202 with the job id when it did not. The worker's own side is
 * tests/unit/export/job.test.ts.
 */
let session: { role: string; username: string; groups?: string[] } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
// The object gate (§4.56) reads the provider's container depth; the worker is what runs the statement.
mock.module("@/lib/db", () => ({ getOrCreateProvider: async () => createMockProvider() }));
const realResolve = await import("@/lib/seed/resolve-connection");
mock.module("@/lib/seed/resolve-connection", () => ({
  ...realResolve,
  resolveConnection: async (body: { connection?: Record<string, unknown> }) => ({
    ...body.connection,
    id: `seed:${(body.connection as { id: string }).id}`,
    seedId: (body.connection as { id: string }).id,
  }),
}));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit, isStatementAuditEnabled: () => false }));
let settled: Partial<JobRecord> | null = null;
let enqueueFails = false;
const enqueued: Record<string, unknown>[] = [];
const realQueue = await import("@/lib/jobs/queue");
mock.module("@/lib/jobs/queue", () => ({
  ...realQueue,
  enqueueJob: async (input: Record<string, unknown>) => {
    if (enqueueFails) throw new Error("store down");
    enqueued.push(input);
    return { id: "job-1", ...input, status: "queued" };
  },
  waitForJob: async (_id: string, _ms: number) => settled,
}));
let file: { result: Record<string, unknown>; content: Buffer } | null = null;
const realRequest = await import("@/lib/export/request");
mock.module("@/lib/export/request", () => ({ ...realRequest, exportFileOf: async () => file }));

const { POST, EXPORT_WAIT_MS } = await import("@/app/api/db/export/route");

const staging = { id: "test-1", name: "Staging", type: "postgres", host: "localhost", environment: "staging" };
const production = { ...staging, name: "Prod", environment: "production" };
const post = (body: Record<string, unknown>) =>
  POST(createMockRequest("/api/db/export", { method: "POST", body }) as never);
const audited = () => audit.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
const done: Partial<JobRecord> = { id: "job-1", kind: "export", status: "done", requestedBy: "ana" };

describe("POST /api/db/export", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
    audit.mockClear();
    enqueued.length = 0;
    enqueueFails = false;
    settled = done;
    file = {
      result: { file: "/x/job-1.csv", extension: "csv", mimeType: "text/csv;charset=utf-8", rows: 2, bytes: 20 },
      content: Buffer.from("﻿id;ssn\n1;***-**-6789\n"),
    };
  });

  test("needs a session, a statement and a known form; nothing is queued before the checks pass", async () => {
    session = null;
    expect((await post({ connection: staging, sql: "SELECT 1", format: "csv" })).status).toBe(401);
    session = { role: "user", username: "ana" };
    expect((await post({ connection: staging, format: "csv" })).status).toBe(400);
    expect((await post({ connection: staging, sql: "SELECT 1", format: "xlsx" })).status).toBe(400);
    expect((await post({ connection: staging, sql: `SELECT '${"x".repeat(1_048_576)}'`, format: "csv" })).status).toBe(
      413,
    );
    expect((await post({ connection: staging, sql: "SELECT 1", format: "csv", params: [{}] })).status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test("the rule first: production without a list is closed, a list opens it to those named, and the refusal is audited", async () => {
    const refused = await post({ connection: production, sql: "SELECT 1", format: "csv" });
    expect(refused.status).toBe(403);
    expect(((await parseResponseJSON(refused)) as { error: string }).error).toContain("not allowed for you");
    expect(audited()[0]).toMatchObject({ type: "permission_denied", reason: "export_not_allowed", user: "ana" });
    expect(enqueued).toHaveLength(0);
    session = { role: "user", username: "ana", groups: ["analysts"] };
    const opened = await post({
      connection: { ...production, exportRoles: ["group:analysts"] },
      sql: "SELECT 1",
      format: "json",
    });
    expect(opened.status).toBe(200);
    expect((await post({ connection: { ...staging, exportRoles: [] }, sql: "SELECT 1", format: "json" })).status).toBe(
      403,
    );
  });

  // docs/CONTEXT.md §4.56: the datasource's object rules, judged before anything is queued.
  test("the object rules: a statement naming a hidden object is refused, audited, and never queued", async () => {
    const ruled = { ...staging, objectRules: [{ match: "public.orders", roles: ["user"] }] };
    const refused = await post({ connection: ruled, sql: "SELECT * FROM public.secrets", format: "csv" });
    expect(refused.status).toBe(403);
    expect(((await parseResponseJSON(refused)) as { error: string }).error).toBe(
      '"public.secrets" is not an object you may use on "Staging".',
    );
    expect(audited()[0]).toMatchObject({ type: "permission_denied", reason: "object_forbidden", user: "ana" });
    expect(enqueued).toHaveLength(0);
    expect((await post({ connection: ruled, sql: "SELECT * FROM public.orders", format: "csv" })).status).toBe(200);
  });

  test("only a statement that reads", async () => {
    const res = await post({ connection: staging, sql: "DELETE FROM t WHERE id = 1", format: "csv" });
    expect(res.status).toBe(400);
    expect(((await parseResponseJSON(res)) as { error: string }).error).toContain("reads");
    expect(enqueued).toHaveLength(0);
  });

  test("hands the export to the queue with the session's principals and streams the file the worker wrote", async () => {
    const res = await post({
      connection: staging,
      sql: "SELECT id, ssn FROM people WHERE id > $1",
      params: [0],
      format: "csv",
      csvDelimiter: ";",
      tabName: "People",
      reveal: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv;charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain('filename="export.csv"');
    expect(res.headers.get("X-Export-Rows")).toBe("2");
    expect(res.headers.get("X-Export-Extension")).toBe("csv");
    expect(res.headers.get("X-Export-Job")).toBe("job-1");
    // The bytes as the worker wrote them: the byte order mark first, which text() would strip.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain("id;ssn");
    expect(enqueued[0]).toMatchObject({ kind: "export", requestedBy: "ana", maxAttempts: 1 });
    expect(enqueued[0].payload as Record<string, unknown>).toEqual({
      session: { role: "user", username: "ana" },
      connectionId: "seed:test-1",
      sql: "SELECT id, ssn FROM people WHERE id > $1",
      params: [0],
      format: "csv",
      csvDelimiter: ";",
      tabName: "People",
      reveal: true,
      ip: expect.any(String),
    });
    expect(EXPORT_WAIT_MS).toBe(30_000);
  });

  test("past the wait it answers 202 with the job; a job that failed or lost its file says so", async () => {
    settled = { id: "job-1", status: "running" };
    const queued = await post({ connection: staging, sql: "SELECT 1", format: "json" });
    expect(queued.status).toBe(202);
    expect((await parseResponseJSON(queued)) as Record<string, unknown>).toEqual({ jobId: "job-1", status: "running" });
    settled = null;
    expect(
      (await parseResponseJSON(await post({ connection: staging, sql: "SELECT 1", format: "json" }))) as Record<
        string,
        unknown
      >,
    ).toEqual({ jobId: "job-1", status: "queued" });
    settled = { id: "job-1", status: "failed", error: "QueryError" };
    const failed = await post({ connection: staging, sql: "SELECT 1", format: "json" });
    expect(failed.status).toBe(500);
    expect(((await parseResponseJSON(failed)) as { error: string }).error).toContain("QueryError");
    settled = { id: "job-1", status: "lost" };
    expect(
      (
        (await parseResponseJSON(await post({ connection: staging, sql: "SELECT 1", format: "json" }))) as {
          error: string;
        }
      ).error,
    ).toContain("stopped answering");
    settled = done;
    file = null;
    expect((await post({ connection: staging, sql: "SELECT 1", format: "json" })).status).toBe(410);
  });

  test("an error that is neither the request's nor the queue's goes through the common error response", async () => {
    enqueueFails = true;
    const res = await post({ connection: staging, sql: "SELECT 1", format: "json" });
    expect(res.status).toBe(500);
    expect(await parseResponseJSON(res)).toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
  });
});
