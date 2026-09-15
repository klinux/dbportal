import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDir, exportFileOf, ExportRequestError, readExportRequest } from "@/lib/export/request";

/** The export request read off the body (docs/CONTEXT.md §4.40), and the worker's file found only under EXPORT_DIR. */
const session = { role: "user", username: "ana", groups: ["g"], namedRoles: ["r"] };
const dir = mkdtempSync(join(tmpdir(), "dbportal-exports-"));

describe("export request", () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads the form, the delimiter, the bindable params, the bounded tab name and the session's principals; refuses what it cannot", () => {
    expect(
      readExportRequest(
        {
          sql: "SELECT 1",
          format: "csv",
          csvDelimiter: ";",
          params: [1, "a", null],
          tabName: ` ${"t".repeat(80)} `,
          reveal: true,
        },
        session,
        "seed:x",
        "1.2.3.4",
      ),
    ).toEqual({
      session,
      connectionId: "seed:x",
      sql: "SELECT 1",
      params: [1, "a", null],
      format: "csv",
      csvDelimiter: ";",
      tabName: "t".repeat(64),
      reveal: true,
      ip: "1.2.3.4",
    });
    expect(
      readExportRequest(
        { sql: "SELECT 1", format: "json", csvDelimiter: "|" },
        { role: "user", username: "bo" },
        "seed:x",
      ),
    ).toEqual({
      session: { role: "user", username: "bo" },
      connectionId: "seed:x",
      sql: "SELECT 1",
      format: "json",
      tabName: "result",
      reveal: false,
    });
    for (const bad of [
      { format: "csv" },
      { sql: "  ", format: "csv" },
      { sql: "SELECT 1", format: "xlsx" },
      { sql: "SELECT 1", format: "csv", params: [{}] },
    ]) {
      expect(() => readExportRequest(bad, session, "seed:x")).toThrow(ExportRequestError);
    }
  });

  test("the file of a done job is read only from under EXPORT_DIR; anything else is nothing", async () => {
    const saved = process.env.EXPORT_DIR;
    process.env.EXPORT_DIR = dir;
    try {
      expect(exportDir()).toBe(dir);
      writeFileSync(join(dir, "job-1.csv"), "a,b");
      const result = { file: join(dir, "job-1.csv"), extension: "csv", mimeType: "text/csv", rows: 1, bytes: 3 };
      const job = {
        id: "job-1",
        kind: "export",
        status: "done" as const,
        result,
        payload: {},
        attempts: 1,
        maxAttempts: 1,
        requestedBy: "ana",
        createdAt: "x",
        runAt: "x",
      };
      const found = await exportFileOf(job);
      expect(found?.content.toString()).toBe("a,b");
      expect(await exportFileOf({ ...job, status: "running" })).toBeNull();
      expect(await exportFileOf({ ...job, result: undefined })).toBeNull();
      expect(await exportFileOf({ ...job, result: { ...result, file: "/etc/passwd" } })).toBeNull();
      expect(await exportFileOf({ ...job, result: { ...result, file: join(dir, "gone.csv") } })).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.EXPORT_DIR;
      else process.env.EXPORT_DIR = saved;
    }
    expect(exportDir()).toContain("data");
  });
});
