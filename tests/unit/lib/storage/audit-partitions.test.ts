import { describe, test, expect } from "bun:test";
import { covers, parseBounds, partitionKind, periodOf, periodsAhead, tsLiteral } from "@/lib/storage/audit-partitions";

/**
 * The audit record's periods (docs/CONTEXT.md §4.43): a calendar month or a week from
 * Monday, named by their first day; the current period and the next ones; the bounds read
 * back off PostgreSQL's own expression; and a literal that takes only an instant of ours.
 */
describe("audit partitions", () => {
  test("the kind is month unless told week", () => {
    expect(partitionKind(undefined)).toBe("month");
    expect(partitionKind(" Week ")).toBe("week");
    expect(partitionKind("day")).toBe("month");
  });

  test("a month runs from its first day to the next month's, a week from Monday to Monday, both named by the first day", () => {
    expect(periodOf(new Date("2026-09-15T13:00:00.000Z"), "month")).toEqual({
      name: "audit_events_p2026_09",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
    expect(periodOf(new Date("2026-12-31T23:59:59.000Z"), "month").to).toBe("2027-01-01T00:00:00.000Z");
    // 2026-09-15 is a Tuesday: its week began Monday the 14th.
    expect(periodOf(new Date("2026-09-15T13:00:00.000Z"), "week")).toEqual({
      name: "audit_events_w2026_09_14",
      from: "2026-09-14T00:00:00.000Z",
      to: "2026-09-21T00:00:00.000Z",
    });
    // A Sunday belongs to the week that began the Monday before it, and a Monday starts its own.
    expect(periodOf(new Date("2026-09-20T10:00:00.000Z"), "week").from).toBe("2026-09-14T00:00:00.000Z");
    expect(periodOf(new Date("2026-09-21T00:00:00.000Z"), "week").from).toBe("2026-09-21T00:00:00.000Z");
  });

  test("periodsAhead is the current period and the next ones, contiguous", () => {
    const periods = periodsAhead(new Date("2026-11-20T00:00:00.000Z"), "month");
    expect(periods.map((p) => p.name)).toEqual([
      "audit_events_p2026_11",
      "audit_events_p2026_12",
      "audit_events_p2027_01",
    ]);
    expect(periods[1].from).toBe(periods[0].to);
    expect(periodsAhead(new Date("2026-09-15T00:00:00.000Z"), "week", 1).map((p) => p.name)).toEqual([
      "audit_events_w2026_09_14",
      "audit_events_w2026_09_21",
    ]);
  });

  test("bounds are read off pg_get_expr, MINVALUE as the legacy partition's open start, and cover their range", () => {
    const monthly = parseBounds("p", "FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00')");
    expect(monthly).toEqual({ name: "p", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    const legacy = parseBounds("l", "FOR VALUES FROM (MINVALUE) TO ('2026-10-01 00:00:00+00')");
    expect(legacy).toEqual({ name: "l", from: null, to: "2026-10-01T00:00:00.000Z" });
    expect(parseBounds("x", "DEFAULT")).toBeNull();
    expect(covers(monthly!, "2026-09-15T00:00:00.000Z")).toBe(true);
    expect(covers(monthly!, "2026-10-01T00:00:00.000Z")).toBe(false);
    expect(covers(legacy!, "1999-01-01T00:00:00.000Z")).toBe(true);
    expect(covers(legacy!, "2026-10-01T00:00:00.000Z")).toBe(false);
  });

  test("a DDL literal is made only from an ISO instant", () => {
    expect(tsLiteral("2026-09-01T00:00:00.000Z")).toBe("'2026-09-01T00:00:00.000Z'");
    expect(() => tsLiteral("2026-09-01'); DROP TABLE x; --")).toThrow("not an ISO instant");
  });
});
