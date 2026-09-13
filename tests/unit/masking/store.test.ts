import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";

/**
 * Server-side masking (docs/CONTEXT.md §4.7) against an in-memory stand-in for the server
 * store: the configuration in force, what an administrator may save, what a result looks
 * like when it leaves, and the audit line a reveal leaves.
 */
let stored: unknown = null;
let enabled = true;
let failRead = false;
const provider = {
  getCollection: mock(async () => {
    if (failRead) throw new Error("store down");
    return stored;
  }),
  setCollection: mock(async (_owner: string, _collection: string, data: unknown) => {
    stored = data;
  }),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled ? provider : null),
}));

const { MaskingError, getServerMaskingConfig, maskResult, resetMaskingConfigCache, saveServerMaskingConfig } =
  await import("@/lib/masking/store");
const { SHARED_MASKING_OWNER } = await import("@/lib/datasources/owner");

const result = {
  rows: [
    { id: 1, email: "ana@example.com", salary: 1200, note: "x" },
    { id: 2, email: null, salary: 80, note: "y" },
  ],
  fields: ["id", "email", "salary", "note"],
};
const user = { role: "user", username: "bob" };
const admin = { role: "admin", username: "root" };

describe("masking store", () => {
  beforeEach(() => {
    stored = null;
    enabled = true;
    failRead = false;
    resetMaskingConfigCache();
    provider.setCollection.mockClear();
  });

  it("masks by the defaults without a store, with nothing stored, with a malformed record, and when the store fails", async () => {
    enabled = false;
    expect(await getServerMaskingConfig()).toEqual(DEFAULT_MASKING_CONFIG);
    enabled = true;
    resetMaskingConfigCache();
    expect(await getServerMaskingConfig()).toEqual(DEFAULT_MASKING_CONFIG);
    resetMaskingConfigCache();
    stored = { enabled: "yes" };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await getServerMaskingConfig()).toEqual(DEFAULT_MASKING_CONFIG);
      resetMaskingConfigCache();
      failRead = true;
      expect(await getServerMaskingConfig()).toEqual(DEFAULT_MASKING_CONFIG);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("saves a valid configuration under the reserved owner, serves it from cache, and refuses an invalid one", async () => {
    const next = { ...DEFAULT_MASKING_CONFIG, enabled: false };
    expect(await saveServerMaskingConfig(next, "root")).toEqual(next);
    expect(provider.setCollection).toHaveBeenCalledWith(SHARED_MASKING_OWNER, "masking_config", next);
    expect((await getServerMaskingConfig()).enabled).toBe(false);
    provider.getCollection.mockClear();
    await getServerMaskingConfig();
    expect(provider.getCollection).not.toHaveBeenCalled();

    const bad = await saveServerMaskingConfig(
      { ...next, patterns: [{ ...next.patterns[0], columnPatterns: ["("] }] } as unknown,
      "root",
    ).catch((e) => e);
    expect(bad).toBeInstanceOf(MaskingError);
    expect(bad.statusCode).toBe(400);
    expect(bad.message).toContain("regular expression");
    const notObject = await saveServerMaskingConfig("nope", "root").catch((e) => e);
    expect(notObject.statusCode).toBe(400);

    enabled = false;
    const noStore = await saveServerMaskingConfig(next, "root").catch((e) => e);
    expect(noStore.statusCode).toBe(503);
    expect(noStore.message).toContain("STORAGE_PROVIDER");
  });

  it("masks the sensitive columns of a result and names them; leaves a result without any untouched", async () => {
    const served = await maskResult(result, { session: user, connectionName: "Orders" });
    expect(served.masked).toEqual(["email", "salary"]);
    expect(served.rows[0].email).not.toBe("ana@example.com");
    expect(String(served.rows[0].email)).toContain("@");
    expect(String(served.rows[0].salary)).toBe("***,***.**");
    expect(served.rows[0].note).toBe("x");
    expect(served.rows[1].email).toBeNull();
    const plain = await maskResult({ rows: [{ id: 1 }], fields: ["id"] }, { session: user, connectionName: "Orders" });
    expect(plain.masked).toEqual([]);
    expect(plain.rows[0].id).toBe(1);
  });

  it("follows the role rules: masking off lets an administrator through, a user who may not toggle stays masked", async () => {
    await saveServerMaskingConfig({ ...DEFAULT_MASKING_CONFIG, enabled: false }, "root");
    expect((await maskResult(result, { session: admin, connectionName: "Orders" })).masked).toEqual([]);
    expect((await maskResult(result, { session: user, connectionName: "Orders" })).masked).toEqual(["email", "salary"]);
  });

  // DESIGN.md: unmasking is itself an audited action - the columns are named, never the values.
  it("a reveal is granted to the roles the configuration names and audited; refused with 403 otherwise", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const revealed = await maskResult(result, { session: admin, connectionName: "Orders", reveal: true });
      expect(revealed.masked).toEqual([]);
      expect(revealed.rows[0].email).toBe("ana@example.com");
      const line = (logSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
        .map((v) => JSON.parse(v) as Record<string, unknown>)
        .find((e) => e.event === "masking_reveal");
      expect(line).toMatchObject({ actor: "root", route: "email,salary", connection: "Orders", outcome: "success" });
      expect(JSON.stringify(line)).not.toContain("ana@example.com");

      const denied = await maskResult(result, { session: user, connectionName: "Orders", reveal: true }).catch(
        (e) => e,
      );
      expect(denied).toBeInstanceOf(MaskingError);
      expect(denied.statusCode).toBe(403);

      // Nothing to reveal: no line.
      logSpy.mockClear();
      await maskResult(
        { rows: [{ id: 1 }], fields: ["id"] },
        { session: admin, connectionName: "Orders", reveal: true },
      );
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("masking_reveal"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a broken audit sink does not turn a permitted reveal into a failure", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const revealed = await maskResult(result, { session: admin, connectionName: "Orders", reveal: true });
      expect(revealed.rows[0].email).toBe("ana@example.com");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
