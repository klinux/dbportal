import { describe, test, expect } from "bun:test";
import {
  hasQualifiedPattern,
  objectScopeFor,
  pathVisible,
  patternRegex,
  referenceLabel,
  referenceVerdict,
  UNRESTRICTED,
  type ObjectRule,
} from "@/lib/objects/rules";

/**
 * The object rules of a datasource (docs/CONTEXT.md §4.56): who a scope is computed for,
 * what a pattern matches, and how a name in a statement is judged.
 */
const RULES: ObjectRule[] = [
  { match: "apim-*", roles: ["group:apim"] },
  { match: "public.orders", roles: ["user"] },
  { match: "audit.*", roles: ["admin"] },
];

describe("objectScopeFor", () => {
  test("no rules, an empty list, or an administrator: unrestricted", () => {
    // The datasource without rules is what it always was; the administrator manages the
    // rules and would otherwise be hidden the very mistake they must fix.
    expect(objectScopeFor(undefined, { role: "user" })).toBe(UNRESTRICTED);
    expect(objectScopeFor([], { role: "user" })).toBe(UNRESTRICTED);
    expect(objectScopeFor(RULES, { role: "admin" })).toBe(UNRESTRICTED);
  });

  test("a person holds exactly the patterns of the rules their principals match", () => {
    expect(objectScopeFor(RULES, { role: "user", groups: ["apim"] })).toEqual({
      restricted: true,
      patterns: ["apim-*", "public.orders"],
    });
    // Rules exist and none is theirs: restricted to nothing, not to everything.
    expect(objectScopeFor([{ match: "x", roles: ["group:other"] }], { role: "user" })).toEqual({
      restricted: true,
      patterns: [],
    });
  });

  test("hasQualifiedPattern says whether any held pattern names a container", () => {
    expect(hasQualifiedPattern(UNRESTRICTED)).toBe(false);
    expect(hasQualifiedPattern({ restricted: true, patterns: ["apim-*"] })).toBe(false);
    expect(hasQualifiedPattern({ restricted: true, patterns: ["apim-*", "public.orders"] })).toBe(true);
  });
});

describe("patternRegex", () => {
  test("* spans any run, ? one character, everything else is literal and case does not matter", () => {
    expect(patternRegex("apim-*").test("APIM-2026.09")).toBe(true);
    expect(patternRegex("log?").test("logs")).toBe(true);
    expect(patternRegex("log?").test("log")).toBe(false);
    // A dot, a plus and a bracket in a pattern are the characters, not regex.
    expect(patternRegex("a.b+c[1]").test("a.b+c[1]")).toBe(true);
    expect(patternRegex("a.b+c[1]").test("aXb+c[1]")).toBe(false);
  });
});

describe("pathVisible", () => {
  const scope = { restricted: true, patterns: ["orders", "public.cust*", "sales.*"] } as const;

  test("an unrestricted scope shows everything; a container-only path is never an object", () => {
    expect(pathVisible(UNRESTRICTED, ["public", "secret"], 1)).toBe(true);
    expect(pathVisible(scope, ["public"], 1)).toBe(false);
  });

  test("a pattern with no dot matches the relation's name in any container", () => {
    expect(pathVisible(scope, ["public", "orders"], 1)).toBe(true);
    expect(pathVisible(scope, ["audit", "orders"], 1)).toBe(true);
    expect(pathVisible(scope, ["orders"], 0)).toBe(true);
    expect(pathVisible(scope, ["public", "orders_old"], 1)).toBe(false);
  });

  test("a pattern with a dot matches the dotted path, and a parent's match covers its children", () => {
    expect(pathVisible(scope, ["public", "customers"], 1)).toBe(true);
    expect(pathVisible(scope, ["public", "customers", "trg_audit"], 1)).toBe(true);
    expect(pathVisible(scope, ["sales", "q1", "idx"], 1)).toBe(true);
    expect(pathVisible(scope, ["public", "invoices"], 1)).toBe(false);
    // The name alone is not the dotted path: `customers` is not `public.cust*`.
    expect(pathVisible(scope, ["customers"], 0)).toBe(false);
  });
});

describe("referenceVerdict", () => {
  const scope = { restricted: true, patterns: ["orders", "public.cust*"] } as const;

  test("unrestricted: every name passes", () => {
    expect(referenceVerdict(UNRESTRICTED, { qualifier: [], name: "anything" }, undefined, 1)).toBeNull();
  });

  test("a wildcard in the name or the qualifier names objects, not one", () => {
    expect(referenceVerdict(scope, { qualifier: [], name: "logs-*" }, undefined, 0)).toBe("wildcard");
    expect(referenceVerdict(scope, { qualifier: ["*"], name: "orders" }, undefined, 1)).toBe("wildcard");
  });

  test("a qualified name is judged as its path", () => {
    expect(referenceVerdict(scope, { qualifier: ["public"], name: "customers" }, undefined, 1)).toBeNull();
    expect(referenceVerdict(scope, { qualifier: ["public"], name: "invoices" }, undefined, 1)).toBe("hidden");
  });

  test("on an engine with no containers the name is the path", () => {
    expect(referenceVerdict({ restricted: true, patterns: ["apim-*"] }, { qualifier: [], name: "apim-1" }, undefined, 0)).toBeNull();
    expect(referenceVerdict({ restricted: true, patterns: ["apim-*"] }, { qualifier: [], name: "logs-1" }, undefined, 0)).toBe("hidden");
  });

  test("an unqualified name is placed in the session's default container when one is known", () => {
    expect(referenceVerdict(scope, { qualifier: [], name: "customers" }, ["public"], 1)).toBeNull();
    expect(referenceVerdict(scope, { qualifier: [], name: "customers" }, ["audit"], 1)).toBe("hidden");
  });

  test("with no default container, only the unqualified patterns can judge an unqualified name", () => {
    // `orders` passes on the name alone; `customers` would need `public.cust*`, which needs
    // a container, so the person is told to qualify it rather than guessed for.
    expect(referenceVerdict(scope, { qualifier: [], name: "orders" }, undefined, 1)).toBeNull();
    expect(referenceVerdict(scope, { qualifier: [], name: "customers" }, undefined, 1)).toBe("unqualified");
    // A default container of the wrong depth is no container.
    expect(referenceVerdict(scope, { qualifier: [], name: "customers" }, ["a", "b"], 1)).toBe("unqualified");
    // No qualified pattern at all: the name is simply not the person's.
    expect(referenceVerdict({ restricted: true, patterns: ["orders"] }, { qualifier: [], name: "customers" }, undefined, 1)).toBe(
      "hidden",
    );
  });

  test("referenceLabel spells the name as written", () => {
    expect(referenceLabel({ qualifier: ["db", "dbo"], name: "Orders" })).toBe("db.dbo.Orders");
    expect(referenceLabel({ qualifier: [], name: "orders" })).toBe("orders");
  });
});
