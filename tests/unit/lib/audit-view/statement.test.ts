import { describe, test, expect } from "bun:test";
import { formatStatement, statementOverview } from "@/lib/audit-view/statement";

/**
 * The admin Audit page's view of a recorded statement (requested 2026-09-14): one line for
 * the row, the whole statement formatted when unfolded, and the text itself when the
 * formatter cannot read it.
 */
describe("statement view", () => {
  test("the overview is one line, cut with an ellipsis past 140 characters", () => {
    expect(statementOverview("  SELECT\n   1  ")).toBe("SELECT 1");
    const long = `SELECT ${"a, ".repeat(80)}b`;
    const overview = statementOverview(long);
    expect(overview.endsWith("…")).toBe(true);
    expect(overview.length).toBe(141);
  });

  test("the full view is formatted as the editor formats, and left alone when unreadable", () => {
    expect(formatStatement("select id, name from orders where id = 1")).toBe(
      "SELECT\n  id,\n  name\nFROM\n  orders\nWHERE\n  id = 1",
    );
    expect(formatStatement("")).toBe("");
    // A MongoDB or Redis command is not SQL; the formatter's refusal keeps the text as it was.
    const command = "db.orders.find({ status: 'open' })";
    expect(formatStatement(command).replace(/\s+/g, " ")).toBe(command.replace(/\s+/g, " "));
  });
});
