import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { QueryError, DatabaseError } from "@/lib/db/errors";

/**
 * The server-built export (docs/CONTEXT.md §4.22): the datasource's export rule first, then
 * only a statement that reads, run again here with its values bound, the rows masked as the
 * grid gets them, the file written in the form asked for, and the trail carrying both the
 * execution and a `data_export` line with the row count. The provider and the session are
 * mocked; the masking store and the writers are real.
 */
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);
let session: { role: string; username: string; groups?: string[] } | null = { role: "user", username: "ana" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));
mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return { resolveConnection: async (body: Record<string, unknown>) => body.connection, SeedConnectionError };
});
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  QueryError,
  DatabaseError,
  isDatabaseError: () => false,
  mapDatabaseError: (e: unknown) => e,
}));
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit, isStatementAuditEnabled: () => false }));

const { POST, EXPORT_MAX_ROWS } = await import("@/app/api/db/export/route");

const staging = { id: "test-1", name: "Staging", type: "postgres", host: "localhost", environment: "staging" };
const production = { ...staging, name: "Prod", environment: "production" };
const post = (body: Record<string, unknown>) =>
  POST(createMockRequest("/api/db/export", { method: "POST", body }) as never);
const audited = () => audit.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("POST /api/db/export", () => {
  beforeEach(() => {
    clearRateLimitState();
    session = { role: "user", username: "ana" };
    audit.mockClear();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [
        { id: 1, ssn: "123-45-6789" },
        { id: 2, ssn: "987-65-4321" },
      ],
      fields: ["id", "ssn"],
      rowCount: 2,
      executionTime: 3,
    }));
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation(
      (query: string, options: { limit?: number }) => ({
        query: `${query} LIMIT ${options.limit}`,
        wasLimited: true,
        limit: options.limit,
        offset: 0,
      }),
    );
  });

  test("needs a session, a statement and a known form", async () => {
    session = null;
    expect((await post({ connection: staging, sql: "SELECT 1", format: "csv" })).status).toBe(401);
    session = { role: "user", username: "ana" };
    expect((await post({ connection: staging, format: "csv" })).status).toBe(400);
    expect((await post({ connection: staging, sql: "SELECT 1", format: "xlsx" })).status).toBe(400);
    expect((await post({ connection: staging, sql: `SELECT '${"x".repeat(1_048_576)}'`, format: "csv" })).status).toBe(
      413,
    );
    expect((await post({ connection: staging, sql: "SELECT 1", format: "csv", params: [{}] })).status).toBe(400);
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("the rule first: production without a list is closed, a list opens it to those named, and the refusal is audited", async () => {
    const refused = await post({ connection: production, sql: "SELECT 1", format: "csv" });
    expect(refused.status).toBe(403);
    expect(((await parseResponseJSON(refused)) as { error: string }).error).toContain("not allowed for you");
    expect(audited()[0]).toMatchObject({ type: "permission_denied", reason: "export_not_allowed", user: "ana" });
    expect(mockProvider.query).not.toHaveBeenCalled();
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

  test("only a statement that reads", async () => {
    const res = await post({ connection: staging, sql: "DELETE FROM t WHERE id = 1", format: "csv" });
    expect(res.status).toBe(400);
    expect(((await parseResponseJSON(res)) as { error: string }).error).toContain("reads");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("builds the file from the re-run, masked, bounded, on a read-only pool, and records the execution and the export", async () => {
    const res = await post({
      connection: staging,
      sql: "SELECT id, ssn FROM people WHERE id > $1",
      params: [0],
      format: "csv",
      csvDelimiter: ";",
      tabName: "People",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv;charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain('filename="export.csv"');
    expect(res.headers.get("X-Export-Rows")).toBe("2");
    expect(res.headers.get("X-Export-Extension")).toBe("csv");
    const text = await res.text();
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("id;ssn");
    expect(text).toContain("***-**-6789");
    expect(text).not.toContain("123-45-6789");
    expect((mockGetOrCreateProvider.mock.calls[0] as unknown[])[1]).toMatchObject({ readOnly: true });
    expect((mockProvider.prepareQuery as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "SELECT id, ssn FROM people WHERE id > $1",
      { limit: EXPORT_MAX_ROWS },
    ]);
    expect((mockProvider.query as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      `SELECT id, ssn FROM people WHERE id > $1 LIMIT ${EXPORT_MAX_ROWS}`,
      [0],
    ]);
    const events = audited();
    expect(events.find((e) => e.type === "query_execution")).toMatchObject({
      action: "export",
      user: "ana",
      connectionName: "Staging",
    });
    expect(events.find((e) => e.type === "data_export")).toMatchObject({
      action: "csv",
      connectionName: "Staging",
      details: "2 rows",
      rows: 2,
    });
  });

  test("a JSON file carries no byte order mark, the datasource's own row cap bounds the file and is said when reached, and a failed run is answered as the engine's error", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
      rows: [{ id: 1 }],
      fields: ["id"],
      rowCount: 1,
      executionTime: 1,
    }));
    const res = await post({
      connection: { ...staging, limits: { maxRows: 1 } },
      sql: "SELECT id FROM t",
      format: "json",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const text = await res.text();
    expect(text.startsWith("[")).toBe(true);
    expect((mockProvider.prepareQuery as ReturnType<typeof mock>).mock.calls.at(-1)?.[1]).toEqual({
      limit: 1,
      unlimited: false,
    });
    expect(audited().find((e) => e.type === "data_export")).toMatchObject({
      details: "1 rows (cut at the cap)",
      rows: 1,
    });
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(new QueryError("syntax error"));
    expect((await post({ connection: staging, sql: "SELEC 1", format: "json" })).status).toBe(400);
  });
});
