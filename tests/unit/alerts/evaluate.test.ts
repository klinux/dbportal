import { describe, test, expect } from "bun:test";
import { asText, describeCondition, evaluate, readValue } from "@/lib/alerts/evaluate";

/**
 * The condition of an alert (docs/CONTEXT.md §4.29): the cell it reads, numeric against
 * numeric and text otherwise, the change since the last run, and the two row-count
 * operators; and the condition as a person reads it.
 */
const result = (rows: Record<string, unknown>[], fields = ["count", "name"]) => ({
  rows,
  fields,
  rowCount: rows.length,
});

describe("alerts evaluate", () => {
  test("reads the named column of the first row, else the first column; nothing from no rows", () => {
    expect(readValue([{ count: 3, name: "a" }], ["count", "name"])).toBe(3);
    expect(readValue([{ count: 3, name: "a" }], ["count", "name"], "name")).toBe("a");
    expect(readValue([], ["count"])).toBeUndefined();
    expect(readValue([{ count: 3 }], [])).toBeUndefined();
    expect(asText(undefined)).toBeUndefined();
    expect(asText(null)).toBe("null");
    expect(asText({ a: 1 })).toBe('{"a":1}');
    expect(asText(1.5)).toBe("1.5");
  });

  test("compares numbers as numbers and anything else as text; a missing value never holds", () => {
    expect(evaluate({ op: ">", value: 100 }, result([{ count: 120 }]), undefined)).toEqual({
      value: "120",
      holds: true,
    });
    expect(evaluate({ op: ">", value: "100" }, result([{ count: "99" }]), undefined).holds).toBe(false);
    expect(evaluate({ op: ">=", value: 120 }, result([{ count: 120 }]), undefined).holds).toBe(true);
    expect(evaluate({ op: "<", value: 1 }, result([{ count: 0 }]), undefined).holds).toBe(true);
    expect(evaluate({ op: "<=", value: 0 }, result([{ count: 1 }]), undefined).holds).toBe(false);
    expect(evaluate({ op: "==", value: "down" }, result([{ count: "down" }]), undefined).holds).toBe(true);
    expect(evaluate({ op: "!=", value: "up" }, result([{ count: "down" }]), undefined).holds).toBe(true);
    expect(evaluate({ op: "==", value: 1 }, result([{ count: null }]), undefined).holds).toBe(false);
    expect(evaluate({ op: ">", value: 1 }, result([]), undefined)).toEqual({ value: undefined, holds: false });
    // Text against text orders as text: "b" > "a".
    expect(evaluate({ op: ">", value: "a", column: "name" }, result([{ count: 1, name: "b" }]), undefined).holds).toBe(
      true,
    );
  });

  test("changed needs a previous value; the row-count operators look at rows only", () => {
    expect(evaluate({ op: "changed" }, result([{ count: 2 }]), undefined).holds).toBe(false);
    expect(evaluate({ op: "changed" }, result([{ count: 2 }]), "2").holds).toBe(false);
    expect(evaluate({ op: "changed" }, result([{ count: 3 }]), "2").holds).toBe(true);
    expect(evaluate({ op: "any_rows" }, result([{ count: 0 }]), undefined).holds).toBe(true);
    expect(evaluate({ op: "any_rows" }, result([]), undefined).holds).toBe(false);
    expect(evaluate({ op: "no_rows" }, result([]), undefined).holds).toBe(true);
    expect(evaluate({ op: "no_rows" }, { rows: [{ x: 1 }], fields: ["x"] }, undefined).holds).toBe(false);
  });

  test("the condition as a person reads it", () => {
    expect(describeCondition({ op: ">", value: 100 })).toBe("value > 100");
    expect(describeCondition({ op: "==", value: "down", column: "status" })).toBe("status == down");
    expect(describeCondition({ op: "changed", column: "version" })).toBe("version changed since the last run");
    expect(describeCondition({ op: "any_rows" })).toBe("any row returned");
    expect(describeCondition({ op: "no_rows" })).toBe("no row returned");
  });
});
