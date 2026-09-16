import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { SeenPrincipalRecord } from "@/lib/storage/types";

/**
 * The people and groups seen signing in (docs/CONTEXT.md §4.49): remembered under the
 * reserved owner as the person and each group, written only when a sign-in brings something
 * new or a day-old date, capped, never a throw - a store in trouble is a warning and nothing
 * to the person logging in; and nothing at all without server storage.
 */
let enabled = true;
let providerDown = false;
let rows: SeenPrincipalRecord[] | null = null;
const provider = {
  getCollection: mock(async () => {
    if (providerDown) throw new Error("disk");
    return rows;
  }),
  setCollection: mock(async (_o: string, _c: string, data: SeenPrincipalRecord[]) => {
    rows = data;
  }),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled ? provider : null),
}));
const { logger } = await import("@/lib/logger");
const { MAX_SEEN, REFRESH_MS, listSeenPrincipals, rememberSignIn, signInPrincipals } = await import(
  "@/lib/principals-seen"
);

describe("seen principals", () => {
  beforeEach(() => {
    enabled = true;
    providerDown = false;
    rows = null;
    provider.getCollection.mockClear();
    provider.setCollection.mockClear();
  });

  test("a sign-in is the person and each group, trimmed, once, and nothing for a blank one", () => {
    expect(signInPrincipals(" ana@example.test ", ["devops", " devops", "", "sre"])).toEqual([
      "user:ana@example.test",
      "group:devops",
      "group:sre",
    ]);
    expect(signInPrincipals("", [" "])).toEqual([]);
  });

  test("remembers new principals with the date, refreshes a day-old one, and leaves a fresh one alone", async () => {
    const t0 = new Date("2026-09-16T10:00:00.000Z");
    await rememberSignIn("ana@example.test", ["devops"], t0);
    expect(await listSeenPrincipals()).toEqual([
      { id: "user:ana@example.test", firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString() },
      { id: "group:devops", firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString() },
    ]);
    // The same person an hour later: nothing to write.
    await rememberSignIn("ana@example.test", ["devops"], new Date(t0.getTime() + 3_600_000));
    expect(provider.setCollection).toHaveBeenCalledTimes(1);
    // A new group on the same person: written, the rest untouched.
    await rememberSignIn("ana@example.test", ["devops", "sre"], new Date(t0.getTime() + 3_600_000));
    expect(provider.setCollection).toHaveBeenCalledTimes(2);
    expect((await listSeenPrincipals()).map((r) => r.id)).toContain("group:sre");
    // A day later: the date moves, the first sighting stays.
    const t1 = new Date(t0.getTime() + REFRESH_MS);
    await rememberSignIn("ana@example.test", [], t1);
    const ana = (await listSeenPrincipals()).find((r) => r.id === "user:ana@example.test");
    expect(ana).toEqual({ id: "user:ana@example.test", firstSeenAt: t0.toISOString(), lastSeenAt: t1.toISOString() });
    // A blank sign-in writes nothing.
    provider.setCollection.mockClear();
    await rememberSignIn("   ", []);
    expect(provider.setCollection).not.toHaveBeenCalled();
  });

  test("the document is capped: past the ceiling the longest unseen go first", async () => {
    rows = Array.from({ length: MAX_SEEN }, (_, i) => {
      const at = new Date(1_700_000_000_000 + i * 1000).toISOString();
      return { id: `user:u${i}@example.test`, firstSeenAt: at, lastSeenAt: at };
    });
    await rememberSignIn("new@example.test", [], new Date(1_800_000_000_000));
    const kept = await listSeenPrincipals();
    expect(kept).toHaveLength(MAX_SEEN);
    expect(kept[0].id).toBe("user:new@example.test");
    expect(kept.some((r) => r.id === "user:u0@example.test")).toBe(false);
    expect(kept.some((r) => r.id === `user:u${MAX_SEEN - 1}@example.test`)).toBe(true);
  });

  test("without server storage nothing is read or written; a store in trouble is one warning, never a throw", async () => {
    enabled = false;
    expect(await listSeenPrincipals()).toEqual([]);
    await rememberSignIn("ana@example.test", ["devops"]);
    expect(provider.getCollection).not.toHaveBeenCalled();
    enabled = true;
    providerDown = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await rememberSignIn("ana@example.test", ["devops"]);
      expect(warn).toHaveBeenCalledWith("Sign-in principals could not be remembered", expect.objectContaining({ error: "Error" }));
    } finally {
      warn.mockRestore();
    }
    await expect(listSeenPrincipals()).rejects.toThrow("disk");
  });
});
