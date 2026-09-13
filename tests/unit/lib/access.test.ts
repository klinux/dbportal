import { describe, test, expect } from "bun:test";
import { canApprove, canWrite, isReadStatement, matchesAccess, normalizeGroups, principalsOf } from "@/lib/access";

/**
 * The access model (docs/CONTEXT.md §4.4): principals from the token, two lists on the
 * datasource, and what "a statement that reads" means to the read-only rule.
 */
describe("principals", () => {
  test("a session is the wildcard, its role and one group principal per group", () => {
    expect(principalsOf({ role: "user", groups: ["sre", "dba"] })).toEqual(["*", "user", "group:sre", "group:dba"]);
    expect(principalsOf({ role: "admin" })).toEqual(["*", "admin"]);
  });

  test("a rule matches when any of its entries is one of the session's principals", () => {
    const principals = principalsOf({ role: "user", groups: ["sre"] });
    expect(matchesAccess(["admin"], principals)).toBe(false);
    expect(matchesAccess(["group:sre"], principals)).toBe(true);
    expect(matchesAccess(["*"], principals)).toBe(true);
    expect(matchesAccess([], principals)).toBe(false);
  });
});

describe("normalizeGroups", () => {
  // A JWT travels in a cookie on every request, so what the provider sends is bounded
  // before it is signed in.
  test("keeps printable strings, deduplicated, bounded in count and length", () => {
    expect(normalizeGroups(["sre", " dba ", "sre", 42, null, "xéy"])).toEqual(["sre", "dba", "xy"]);
    expect(normalizeGroups("single")).toEqual(["single"]);
    expect(normalizeGroups(undefined)).toEqual([]);
    expect(normalizeGroups(Array.from({ length: 80 }, (_, i) => `g${i}`)).length).toBe(50);
    expect(normalizeGroups(["x".repeat(100)])[0].length).toBe(64);
  });
});

describe("canWrite", () => {
  const roles = ["*"];
  test("no writeRoles means everyone who can open may write", () => {
    expect(canWrite({ roles }, { role: "user" })).toBe(true);
  });
  test("an empty writeRoles is read-only for everyone, administrators included", () => {
    expect(canWrite({ roles, writeRoles: [] }, { role: "admin" })).toBe(false);
  });
  test("a group in writeRoles grants writes to its members only", () => {
    expect(canWrite({ roles, writeRoles: ["group:dba"] }, { role: "user", groups: ["dba"] })).toBe(true);
    expect(canWrite({ roles, writeRoles: ["group:dba"] }, { role: "admin" })).toBe(false);
  });
});

describe("isReadStatement", () => {
  test("a SELECT, a read-only WITH, SHOW and DESCRIBE read; the rest writes", () => {
    expect(isReadStatement("SELECT * FROM t", "postgres")).toBe(true);
    expect(isReadStatement("  -- note\n/* c */ select 1", "postgres")).toBe(true);
    expect(isReadStatement("WITH x AS (SELECT 1) SELECT * FROM x", "postgres")).toBe(true);
    expect(isReadStatement("SHOW TABLES", "mysql")).toBe(true);
    expect(isReadStatement("DESCRIBE users", "mysql")).toBe(true);
    expect(isReadStatement("UPDATE t SET a = 1", "postgres")).toBe(false);
    expect(isReadStatement("DELETE FROM t", "postgres")).toBe(false);
    expect(isReadStatement("DROP TABLE t", "postgres")).toBe(false);
    expect(isReadStatement("CALL do_things()", "postgres")).toBe(false);
  });

  // `EXPLAIN ANALYZE UPDATE ...` RUNS the update: the statement under the EXPLAIN is what
  // gets judged.
  test("an EXPLAIN reads only when the statement it explains reads", () => {
    expect(isReadStatement("EXPLAIN SELECT 1", "postgres")).toBe(true);
    expect(isReadStatement("EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1", "postgres")).toBe(true);
    expect(isReadStatement("EXPLAIN ANALYZE UPDATE t SET a = 1", "postgres")).toBe(false);
    expect(isReadStatement("EXPLAIN FORMAT=JSON DELETE FROM t", "mysql")).toBe(false);
    expect(isReadStatement("EXPLAIN", "postgres")).toBe(false);
  });

  // A rule that cannot be enforced must not be reported as enforced: an engine whose
  // statements are not SQL text is refused entirely under a read-only rule.
  test("an engine without SQL text is never a read", () => {
    expect(isReadStatement('{"find": "users"}', "mongodb")).toBe(false);
    expect(isReadStatement("GET key", "redis")).toBe(false);
  });
});

describe("canApprove", () => {
  // docs/CONTEXT.md §4.6: reviewers are the datasource's approverRoles, or administrators.
  test("administrators review by default; approverRoles replaces that, not extends it", () => {
    expect(canApprove({}, { role: "admin" })).toBe(true);
    expect(canApprove({}, { role: "user", groups: ["dba"] })).toBe(false);
    expect(canApprove({ approverRoles: ["group:dba"] }, { role: "user", groups: ["dba"] })).toBe(true);
    expect(canApprove({ approverRoles: ["group:dba"] }, { role: "admin" })).toBe(false);
  });
});
