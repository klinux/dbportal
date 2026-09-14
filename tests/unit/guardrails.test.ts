import { describe, test, expect } from "bun:test";
import { GUARDRAIL_LABEL, dangerOf, firstGuardrail } from "@/lib/guardrails";

/**
 * Guardrails (docs/CONTEXT.md §4.15): which statements trip one, and which do not - a WHERE
 * inside a comment or a string does not count, a WHERE in the code does, and the four
 * shapes are the only four.
 */
describe("dangerOf", () => {
  test("a DELETE or UPDATE without WHERE trips; with one it does not", () => {
    expect(dangerOf("DELETE FROM orders", "postgres")).toBe("delete_without_where");
    expect(dangerOf("delete from orders;", "postgres")).toBe("delete_without_where");
    expect(dangerOf("UPDATE orders SET paid = true", "postgres")).toBe("update_without_where");
    expect(dangerOf("DELETE FROM orders WHERE id = 1", "postgres")).toBeNull();
    expect(dangerOf("UPDATE orders SET paid = true WHERE id IN (1, 2)", "postgres")).toBeNull();
  });

  test("a WHERE in a comment or a string literal is not a WHERE", () => {
    expect(dangerOf("DELETE FROM orders -- where?", "postgres")).toBe("delete_without_where");
    expect(dangerOf("DELETE FROM orders /* WHERE id = 1 */", "postgres")).toBe("delete_without_where");
    expect(dangerOf("UPDATE t SET note = 'where it was'", "postgres")).toBe("update_without_where");
    expect(dangerOf("UPDATE t SET note = 'it''s where' WHERE id = 1", "postgres")).toBeNull();
  });

  test("DROP and TRUNCATE trip whatever follows; a leading comment does not hide them", () => {
    expect(dangerOf("DROP TABLE orders", "postgres")).toBe("drop");
    expect(dangerOf("  drop index if exists i", "mysql")).toBe("drop");
    expect(dangerOf("TRUNCATE orders", "postgres")).toBe("truncate");
    expect(dangerOf("/* note */ TRUNCATE TABLE orders", "postgres")).toBe("truncate");
  });

  test("everything else is left to the write rule", () => {
    expect(dangerOf("SELECT * FROM orders", "postgres")).toBeNull();
    expect(dangerOf("INSERT INTO orders VALUES (1)", "postgres")).toBeNull();
    expect(dangerOf("CREATE TABLE t (id int)", "postgres")).toBeNull();
    expect(dangerOf("ALTER TABLE t ADD c int", "postgres")).toBeNull();
    expect(dangerOf("", "postgres")).toBeNull();
    // A data-modifying CTE is typed by what it operates, like the read-only gate reads it.
    expect(dangerOf("WITH x AS (SELECT 1) DELETE FROM orders", "postgres")).toBe("delete_without_where");
  });

  test("firstGuardrail reports the first statement that trips, and every guardrail has a label", () => {
    expect(firstGuardrail(["SELECT 1", "DELETE FROM a WHERE 1=1", "TRUNCATE b", "DROP TABLE c"], "postgres")).toBe(
      "truncate",
    );
    expect(firstGuardrail(["SELECT 1"], "postgres")).toBeNull();
    for (const key of ["delete_without_where", "update_without_where", "drop", "truncate"] as const) {
      expect(GUARDRAIL_LABEL[key].length).toBeGreaterThan(0);
    }
  });
});
