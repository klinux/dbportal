import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import { DEFAULT_STORAGE_SQLITE_PATH, getDataDir, resolveStorageSqlitePath, LEGACY_STORAGE_SQLITE_PATH } from "@/lib/data-dir";

describe("data-dir getDataDir()", () => {
  let origStoragePath: string | undefined;

  beforeEach(() => {
    origStoragePath = process.env.STORAGE_SQLITE_PATH;
  });

  afterEach(() => {
    if (origStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = origStoragePath;
  });

  test("defaults to the directory of the default SQLite storage path", () => {
    delete process.env.STORAGE_SQLITE_PATH;
    expect(getDataDir()).toBe(path.dirname(DEFAULT_STORAGE_SQLITE_PATH));
  });

  test("derives the data dir from STORAGE_SQLITE_PATH when set", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(getDataDir()).toBe("/var/lib/libredb");
  });

  test("treats an empty STORAGE_SQLITE_PATH as unset", () => {
    process.env.STORAGE_SQLITE_PATH = "";
    expect(getDataDir()).toBe(path.dirname(DEFAULT_STORAGE_SQLITE_PATH));
  });
});

// docs/CONTEXT.md §5, layer 3: the snapshot's default file keeps being used until the new
// one exists, so an upgrade keeps every stored row without a rename step.
describe("resolveStorageSqlitePath", () => {
  const saved = process.env.STORAGE_SQLITE_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = saved;
  });
  test("the operator's path wins; else the new default, unless only the old default exists", () => {
    delete process.env.STORAGE_SQLITE_PATH;
    expect(resolveStorageSqlitePath(() => false)).toBe(DEFAULT_STORAGE_SQLITE_PATH);
    expect(resolveStorageSqlitePath((p) => p === LEGACY_STORAGE_SQLITE_PATH)).toBe(LEGACY_STORAGE_SQLITE_PATH);
    expect(resolveStorageSqlitePath(() => true)).toBe(DEFAULT_STORAGE_SQLITE_PATH);
    process.env.STORAGE_SQLITE_PATH = "/srv/x.db";
    expect(resolveStorageSqlitePath(() => true)).toBe("/srv/x.db");
  });
});
