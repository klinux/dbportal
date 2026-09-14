import { describe, test, expect } from "bun:test";
import type { AuditEvent } from "@/lib/audit";
import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, matchesAuditQuery, readAuditQuery } from "@/lib/audit-query";

/**
 * The Audit page's question (docs/CONTEXT.md §4.27): read once from the query string,
 * bounded, refused with the reason when malformed; and asked of one event for the ring.
 */
const read = (qs: string) => readAuditQuery(new URLSearchParams(qs));

describe("readAuditQuery", () => {
  test("reads every filter, normalises the instants, and defaults the page", () => {
    expect(read("")).toEqual({ query: { limit: AUDIT_PAGE_DEFAULT, offset: 0 } });
    expect(
      read(
        "type=query_execution&actor=ana&connection=Orders&result=failure&from=2026-09-01&to=2026-09-14T10:00:00Z&limit=50&offset=100",
      ),
    ).toEqual({
      query: {
        type: "query_execution",
        actor: "ana",
        connectionName: "Orders",
        result: "failure",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-14T10:00:00.000Z",
        limit: 50,
        offset: 100,
      },
    });
    expect(read("actor=%20%20")).toEqual({ query: { limit: AUDIT_PAGE_DEFAULT, offset: 0 } });
  });

  test("refuses a bad date, an inverted period, a page outside its bounds, and an unknown result", () => {
    expect(read("from=yesterday")).toEqual({ error: "from and to must be dates" });
    expect(read("from=2026-09-14&to=2026-09-01")).toEqual({ error: "from must not be after to" });
    expect(read("limit=0")).toEqual({ error: `limit must be an integer between 1 and ${AUDIT_PAGE_MAX}` });
    expect(read(`limit=${AUDIT_PAGE_MAX + 1}`)).toEqual({
      error: `limit must be an integer between 1 and ${AUDIT_PAGE_MAX}`,
    });
    expect(read("limit=ten")).toEqual({ error: `limit must be an integer between 1 and ${AUDIT_PAGE_MAX}` });
    expect(read("offset=-1")).toEqual({ error: "offset must be a non-negative integer" });
    expect(read("result=maybe")).toEqual({ error: 'result must be "success" or "failure"' });
  });

  test("matchesAuditQuery asks the same question of one event", () => {
    const event: AuditEvent = {
      id: "e1",
      timestamp: "2026-09-10T12:00:00.000Z",
      type: "query_execution",
      action: "query",
      target: "t",
      user: "ana",
      connectionName: "Orders",
      result: "success",
    };
    expect(matchesAuditQuery(event, {})).toBe(true);
    expect(
      matchesAuditQuery(event, { type: "query_execution", actor: "ana", connectionName: "Orders", result: "success" }),
    ).toBe(true);
    expect(matchesAuditQuery(event, { type: "maintenance" })).toBe(false);
    expect(matchesAuditQuery(event, { actor: "bob" })).toBe(false);
    expect(matchesAuditQuery(event, { connectionName: "HR" })).toBe(false);
    expect(matchesAuditQuery(event, { result: "failure" })).toBe(false);
    expect(matchesAuditQuery(event, { from: "2026-09-11T00:00:00.000Z" })).toBe(false);
    expect(matchesAuditQuery(event, { to: "2026-09-09T00:00:00.000Z" })).toBe(false);
    expect(matchesAuditQuery(event, { from: "2026-09-10T00:00:00.000Z", to: "2026-09-10T23:59:59.000Z" })).toBe(true);
  });
});
