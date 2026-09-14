import { describe, test, expect } from "bun:test";
import { firstTransactionControl, isTransactionControl } from "@/lib/sql/transaction-control";

/**
 * Transaction control as a statement (docs/CONTEXT.md §4.21): the seven keywords, read
 * past leading comments under the engine's grammar, and nothing on an engine whose
 * statements are not SQL text - there is no pool of SQL connections to leak there.
 */
describe("isTransactionControl", () => {
  test("names BEGIN, START TRANSACTION, COMMIT, ROLLBACK, SAVEPOINT, RELEASE and END, past comments, in any case", () => {
    for (const sql of [
      "BEGIN",
      "begin;",
      "START TRANSACTION",
      "COMMIT",
      "rollback to savepoint s1",
      "SAVEPOINT s1",
      "RELEASE SAVEPOINT s1",
      "END",
      "-- note\n/* more */ BEGIN",
    ]) {
      expect({ sql, control: isTransactionControl(sql, "postgres") }).toEqual({ sql, control: true });
    }
  });

  test("leaves every other statement alone, including a commented-out BEGIN, and every non-SQL engine", () => {
    for (const sql of ["SELECT 1", "UPDATE t SET a = 1 WHERE id = 1", "-- BEGIN\nSELECT 1", "'BEGIN'", ""]) {
      expect({ sql, control: isTransactionControl(sql, "postgres") }).toEqual({ sql, control: false });
    }
    expect(isTransactionControl("BEGIN", "mongodb")).toBe(false);
    expect(isTransactionControl("BEGIN", "redis")).toBe(false);
    // An unterminated comment hides the keyword; that reads as no control, the way the classifiers read it.
    expect(isTransactionControl("/* BEGIN", "postgres")).toBe(false);
  });

  test("firstTransactionControl answers the first such statement of a script, or null", () => {
    expect(firstTransactionControl(["SELECT 1", "COMMIT", "BEGIN"], "mysql")).toBe("COMMIT");
    expect(firstTransactionControl(["SELECT 1", "SELECT 2"], "mysql")).toBeNull();
  });
});
