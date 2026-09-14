import { describe, test, expect } from "bun:test";
import { isReadStatement } from "@/lib/access";
import { dangerOf, firstGuardrail } from "@/lib/guardrails";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { firstTransactionControl } from "@/lib/sql/transaction-control";

/**
 * Large and elaborate scripts (docs/CONTEXT.md §4.21): everything that reads a statement
 * before it runs - the splitter, the read-only gate, the guardrails, the classifier, the
 * transaction-control reader - stays linear on an `UPDATE … WHERE id IN (…)` of twenty
 * thousand ids and on a script of two thousand statements, and still reads them right.
 * The bound is generous so a slow CI machine passes; a quadratic reader would take
 * seconds, not tens of milliseconds.
 */
const ids = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i).join(", ");
const update = (n: number) => `UPDATE orders SET status = 'archived' WHERE id IN (${ids(n)})`;
const script = (n: number) =>
  Array.from({ length: n }, (_, i) => `-- ${i}\nUPDATE orders SET note = 'row ${i}' WHERE id = ${i};`).join("\n");
const BUDGET_MS = 1_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("large statements", () => {
  test("a two-thousand-id UPDATE and a twenty-thousand-id UPDATE are read as a bounded write in bounded time", () => {
    for (const n of [2_000, 20_000]) {
      const sql = update(n);
      const danger = timed(() => dangerOf(sql, "postgres"));
      const read = timed(() => isReadStatement(sql, "postgres"));
      const shape = timed(() => analyzeQuery(sql, "postgres").type);
      const control = timed(() => firstTransactionControl([sql], "postgres"));
      const split = timed(() => splitStatements(sql, resolveSqlGrammar("postgres")));
      expect({ n, danger: danger.value, read: read.value, shape: shape.value, control: control.value }).toEqual({
        n,
        danger: null,
        read: false,
        shape: "UPDATE",
        control: null,
      });
      expect(split.value).toHaveLength(1);
      for (const [name, ms] of [
        ["dangerOf", danger.ms],
        ["isReadStatement", read.ms],
        ["analyzeQuery", shape.ms],
        ["firstTransactionControl", control.ms],
        ["splitStatements", split.ms],
      ] as const) {
        expect({ n, name, withinBudget: ms < BUDGET_MS }).toEqual({ n, name, withinBudget: true });
      }
    }
  });

  test("a two-thousand-statement script splits into its statements and is judged whole in bounded time", () => {
    const sql = script(2_000);
    const split = timed(() => splitStatements(sql, resolveSqlGrammar("postgres")));
    expect(split.value).toHaveLength(2_000);
    const statements = split.value.map((s) => s.sql);
    const guard = timed(() => firstGuardrail(statements, "postgres"));
    const gate = timed(() => statements.every((s) => !isReadStatement(s, "postgres")));
    const control = timed(() => firstTransactionControl(statements, "postgres"));
    expect({ guard: guard.value, allWrites: gate.value, control: control.value }).toEqual({
      guard: null,
      allWrites: true,
      control: null,
    });
    for (const [name, ms] of [
      ["splitStatements", split.ms],
      ["firstGuardrail", guard.ms],
      ["isReadStatement×2000", gate.ms],
      ["firstTransactionControl", control.ms],
    ] as const) {
      expect({ name, withinBudget: ms < BUDGET_MS }).toEqual({ name, withinBudget: true });
    }
    // The same script with a bare DELETE at its end still trips the guardrail, and one with a
    // COMMIT in the middle is still found.
    expect(firstGuardrail([...statements, "DELETE FROM orders"], "postgres")).toBe("delete_without_where");
    expect(
      firstTransactionControl([...statements.slice(0, 1000), "COMMIT", ...statements.slice(1000)], "postgres"),
    ).toBe("COMMIT");
  });
});
