import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProvider } from "../../helpers/mock-provider";
import { QueryError } from "@/lib/db/errors";

/**
 * The worker's side of an export (docs/CONTEXT.md §4.22, §4.40): the rule checked again as
 * the token would be, only a read, the re-run on a read-only pool bounded by the cap, the
 * rows masked, the file written under EXPORT_DIR by the job's id with a byte order mark for
 * CSV and none for JSON, two audit lines, and the files past retention removed.
 */
let session: { role: string; username: string; groups?: string[] };
mock.module("@/lib/roles/store", () => ({ withNamedRoles: async (s: unknown) => s }));
const datasources: Record<string, Record<string, unknown>> = {
  "seed:staging": { id: "seed:staging", name: "Staging", type: "postgres", environment: "staging" },
  "seed:prod": { id: "seed:prod", name: "Prod", type: "postgres", environment: "production" },
  "seed:capped": {
    id: "seed:capped",
    name: "Capped",
    type: "postgres",
    environment: "staging",
    limits: { maxRows: 1 },
  },
};
mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: async (body: { connectionId: string }, s: unknown) => {
    session = s as typeof session;
    return datasources[body.connectionId];
  },
}));
const mockProvider = createMockProvider();
const getOrCreateProvider = mock(async () => mockProvider);
mock.module("@/lib/db", () => ({ getOrCreateProvider }));
const audit = mock((_e: Record<string, unknown>) => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit, isStatementAuditEnabled: () => false }));
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { warn, info: () => {}, error: () => {}, debug: () => {} } }));

const dir = mkdtempSync(join(tmpdir(), "dbportal-exports-"));
process.env.EXPORT_DIR = dir;
const { DEFAULT_EXPORT_RETENTION_HOURS, EXPORT_MAX_ROWS, exportRetentionMs, pruneExports, runExport } = await import(
  "@/lib/export/job"
);
const { ExportRequestError } = await import("@/lib/export/request");

const payload = (over: Record<string, unknown> = {}) => ({
  session: { role: "user", username: "ana" },
  connectionId: "seed:staging",
  sql: "SELECT id, ssn FROM people WHERE id > $1",
  params: [0],
  format: "csv" as const,
  csvDelimiter: ";" as const,
  tabName: "People",
  reveal: false,
  ip: "10.0.0.1",
  ...over,
});
const audited = () => audit.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("export job", () => {
  beforeEach(() => {
    audit.mockClear();
    warn.mockClear();
    getOrCreateProvider.mockClear();
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
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("builds the file from the re-run, masked, bounded, on a read-only pool, under the job's id, and records the execution and the export", async () => {
    const result = await runExport(payload(), "job-1");
    expect(result).toMatchObject({
      file: join(dir, "job-1.csv"),
      extension: "csv",
      mimeType: "text/csv;charset=utf-8",
      rows: 2,
    });
    const text = readFileSync(result.file, "utf8");
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("id;ssn");
    expect(text).toContain("***-**-6789");
    expect(text).not.toContain("123-45-6789");
    expect(result.bytes).toBe(Buffer.byteLength(text));
    expect((getOrCreateProvider.mock.calls[0] as unknown[])[1]).toMatchObject({
      readOnly: true,
      applicationName: expect.any(String),
    });
    expect((mockProvider.prepareQuery as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "SELECT id, ssn FROM people WHERE id > $1",
      { limit: EXPORT_MAX_ROWS },
    ]);
    expect((mockProvider.query as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      `SELECT id, ssn FROM people WHERE id > $1 LIMIT ${EXPORT_MAX_ROWS}`,
      [0],
    ]);
    expect(audited().find((e) => e.type === "query_execution")).toMatchObject({
      action: "export",
      user: "ana",
      connectionName: "Staging",
      ip: "10.0.0.1",
    });
    expect(audited().find((e) => e.type === "data_export")).toMatchObject({
      action: "csv",
      connectionName: "Staging",
      details: "2 rows",
      rows: 2,
    });
  });

  test("a JSON file carries no byte order mark, the datasource's own cap bounds it and is said when reached, a failed run is the engine's error", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
      rows: [{ id: 1 }],
      fields: ["id"],
      rowCount: 1,
      executionTime: 1,
    }));
    const result = await runExport(
      payload({ connectionId: "seed:capped", format: "json", params: undefined }),
      "job-2",
    );
    expect(result.mimeType).toBe("application/json");
    expect(readFileSync(result.file, "utf8").startsWith("[")).toBe(true);
    expect((mockProvider.prepareQuery as ReturnType<typeof mock>).mock.calls.at(-1)?.[1]).toEqual({
      limit: 1,
      unlimited: false,
    });
    expect(audited().find((e) => e.type === "data_export")).toMatchObject({
      details: "1 rows (cut at the cap)",
      rows: 1,
    });
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(new QueryError("syntax error"));
    await expect(runExport(payload({ sql: "SELECT nope" }), "job-3")).rejects.toBeInstanceOf(QueryError);
    expect(existsSync(join(dir, "job-3.csv"))).toBe(false);
  });

  test("the rule again on the worker: production closed to this person is refused and audited; a write is refused; nothing is written", async () => {
    const refused = await runExport(payload({ connectionId: "seed:prod" }), "job-4").catch((e) => e);
    expect(refused).toBeInstanceOf(ExportRequestError);
    expect(refused.statusCode).toBe(403);
    expect(audited()[0]).toMatchObject({ type: "permission_denied", reason: "export_not_allowed", user: "ana" });
    expect(session.username).toBe("ana");
    const write = await runExport(payload({ sql: "DELETE FROM people" }), "job-5").catch((e) => e);
    expect(write.statusCode).toBe(400);
    expect(mockProvider.query).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "job-4.csv"))).toBe(false);
  });

  test("files past retention are removed after an export; a directory that cannot be read is one warning", async () => {
    expect(exportRetentionMs()).toBe(DEFAULT_EXPORT_RETENTION_HOURS * 3_600_000);
    process.env.EXPORT_RETENTION_HOURS = "2";
    expect(exportRetentionMs()).toBe(2 * 3_600_000);
    const old = join(dir, "old.csv");
    writeFileSync(old, "x");
    const stale = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(old, stale, stale);
    const fresh = join(dir, "fresh.csv");
    writeFileSync(fresh, "y");
    expect(await pruneExports()).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    delete process.env.EXPORT_RETENTION_HOURS;
    process.env.EXPORT_DIR = join(dir, "missing");
    expect(await pruneExports()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "Export directory could not be pruned",
      expect.objectContaining({ route: "export/job" }),
    );
    process.env.EXPORT_DIR = dir;
  });
});
