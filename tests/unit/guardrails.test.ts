import { describe, test, expect } from "bun:test";
import { GUARDRAIL_LABEL, dangerOf, firstGuardrail } from "@/lib/guardrails";

/**
 * Guardrails (docs/CONTEXT.md §4.15): which statements trip one, and which do not - a WHERE
 * inside a comment or a string does not count, a WHERE in the code does, and the shapes
 * listed are the only ones.
 */
describe("dangerOf", () => {
  test("every DELETE trips; an UPDATE only without a WHERE", () => {
    expect(dangerOf("DELETE FROM orders", "postgres")).toBe("delete_without_where");
    expect(dangerOf("delete from orders;", "postgres")).toBe("delete_without_where");
    expect(dangerOf("UPDATE orders SET paid = true", "postgres")).toBe("update_without_where");
    // A DELETE with a WHERE waits too, under its own name so a reviewer can tell
    // the two apart on the approvals page.
    expect(dangerOf("DELETE FROM orders WHERE id = 1", "postgres")).toBe("delete");
    expect(dangerOf("UPDATE orders SET paid = true WHERE id IN (1, 2)", "postgres")).toBeNull();
  });

  // Why every DELETE and not only the bare one: the WHERE test asks whether the word is
  // present, and a predicate that is always true satisfies it. Measured against a real
  // Postgres, `DELETE FROM department WHERE 1=1` ran with no reviewer and left 0 of 3 rows.
  test("a predicate that is always true no longer passes a DELETE through", () => {
    expect(dangerOf("DELETE FROM orders WHERE 1=1", "postgres")).toBe("delete");
    expect(dangerOf("DELETE FROM orders WHERE true", "postgres")).toBe("delete");
    expect(dangerOf("DELETE FROM orders WHERE 'a' = 'a'", "postgres")).toBe("delete");
    expect(dangerOf("DELETE FROM orders USING t WHERE true", "postgres")).toBe("delete");
  });

  // The UPDATE half: every UPDATE is not held - the single-row edit is what the route exists
  // for - but the spellings that are true of every row by construction are read, since
  // `UPDATE t SET c = 1 WHERE 1=1` rewrote every row with no reviewer. A list can be outrun;
  // the general case stays open in docs/CONTEXT.md §4.15.
  test("an UPDATE whose WHERE is always true trips, under its own name", () => {
    expect(dangerOf("UPDATE orders SET paid = true WHERE 1=1", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE 1 = 1;", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE true", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE TRUE RETURNING id", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE 1", "mysql")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE 'a' = 'a'", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE id = id", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE (1=1)", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE id = 5 OR 1=1", "postgres")).toBe("update_always_true");
    expect(dangerOf("UPDATE orders SET paid = true WHERE id = 5 OR (status = 'x' OR true)", "postgres")).toBe(
      "update_always_true",
    );
    // Toward holding: two blanked strings compare equal whether they were.
    expect(dangerOf("UPDATE orders SET paid = true WHERE 'a' = 'b'", "postgres")).toBe("update_always_true");
    // Bounded predicates pass, an OR inside parentheses is not a top-level branch, and a
    // value compared to a different one is not the same token.
    expect(dangerOf("UPDATE orders SET paid = true WHERE id = 1", "postgres")).toBeNull();
    expect(dangerOf("UPDATE orders SET paid = true WHERE id = 1 ORDER BY id LIMIT 1", "mysql")).toBeNull();
    expect(dangerOf("UPDATE orders SET paid = true WHERE (id = 5 OR 1=1) AND status = 'x'", "postgres")).toBeNull();
    expect(dangerOf("UPDATE orders SET paid = true WHERE id = 1 OR id = 2", "postgres")).toBeNull();
    expect(dangerOf("UPDATE orders SET paid = true WHERE a = b", "postgres")).toBeNull();
    expect(dangerOf("UPDATE orders SET paid = true WHERE id > 0", "postgres")).toBeNull();
  });

  // A SELECT is not a DELETE because the word appears in it.
  test("the shape is read, not the word", () => {
    expect(dangerOf("SELECT * FROM orders WHERE deleted_at IS NULL", "postgres")).toBeNull();
    expect(dangerOf("SELECT 'delete from orders'", "postgres")).toBeNull();
    expect(dangerOf("INSERT INTO audit SELECT * FROM orders WHERE id = 1", "postgres")).toBeNull();
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

  // A privilege change neither reads nor writes a row, so the write rule never saw it and
  // `analyzeQuery` types it as neither a DELETE nor an UPDATE: it reached the engine having
  // passed no gate at all.
  test("a privilege change trips, whatever it grants and to whom", () => {
    expect(dangerOf("GRANT SELECT ON orders TO reporting", "postgres")).toBe("grant");
    expect(dangerOf("grant all privileges on *.* to 'bot'@'%'", "mysql")).toBe("grant");
    expect(dangerOf("REVOKE INSERT ON orders FROM reporting", "postgres")).toBe("grant");
    expect(dangerOf("/* ticket-42 */ GRANT USAGE ON SCHEMA public TO app", "postgres")).toBe("grant");
  });

  test("CREATE and ALTER trip only when the subject is an identity", () => {
    expect(dangerOf("CREATE ROLE reporting", "postgres")).toBe("grant");
    expect(dangerOf("CREATE USER bot WITH PASSWORD 'x'", "postgres")).toBe("grant");
    expect(dangerOf("ALTER ROLE app SET search_path = public", "postgres")).toBe("grant");
    expect(dangerOf("alter user 'bot'@'%' identified by 'x'", "mysql")).toBe("grant");
    // `OR REPLACE` sits between the verb and the subject (MariaDB).
    expect(dangerOf("CREATE OR REPLACE USER bot IDENTIFIED BY 'x'", "mysql")).toBe("grant");
    // A table is not an identity: these stay with the write rule, as before.
    expect(dangerOf("CREATE TABLE role (id int)", "postgres")).toBeNull();
    expect(dangerOf("ALTER TABLE users ADD c int", "postgres")).toBeNull();
    expect(dangerOf("CREATE INDEX i ON users (id)", "postgres")).toBeNull();
  });

  // `ALTER DEFAULT PRIVILEGES` grants on every table created from then on, so it is the
  // shape a reviewer most wants to see — and the word GRANT is not what leads it.
  test("ALTER DEFAULT PRIVILEGES trips, and does not drag ALTER TABLE with it", () => {
    expect(dangerOf("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting", "postgres")).toBe(
      "grant",
    );
    expect(dangerOf("ALTER DEFAULT PRIVILEGES REVOKE INSERT ON TABLES FROM app", "postgres")).toBe("grant");
    expect(dangerOf("ALTER TABLE defaults ADD c int", "postgres")).toBeNull();
  });

  // Two-word leaders that change an identity or its credential, leading with neither
  // GRANT/REVOKE nor CREATE/ALTER.
  test("RENAME USER and SET PASSWORD trip", () => {
    expect(dangerOf("RENAME USER a TO b", "mysql")).toBe("grant");
    expect(dangerOf("SET PASSWORD FOR 'bot'@'%' = 'x'", "mysql")).toBe("grant");
    // A plain SET is a session setting, not a credential.
    expect(dangerOf("SET search_path = public", "postgres")).toBeNull();
    expect(dangerOf("RENAME TABLE a TO b", "mysql")).toBeNull();
  });

  test("the word in a string or a comment is not a privilege change", () => {
    expect(dangerOf("SELECT * FROM audit WHERE action = 'grant'", "postgres")).toBeNull();
    expect(dangerOf("-- GRANT SELECT ON orders TO reporting\nSELECT 1", "postgres")).toBeNull();
    expect(dangerOf("INSERT INTO log (note) VALUES ('revoke access')", "postgres")).toBeNull();
  });

  test("firstGuardrail reports the first statement that trips, and every guardrail has a label", () => {
    // `DELETE ... WHERE 1=1` used to stand here as the harmless statement the scan
    // walks past - which is the bug this rule closes. A plain SELECT is the harmless one.
    expect(firstGuardrail(["SELECT 1", "SELECT 2", "TRUNCATE b", "DROP TABLE c"], "postgres")).toBe("truncate");
    expect(firstGuardrail(["SELECT 1", "DELETE FROM a WHERE 1=1", "TRUNCATE b"], "postgres")).toBe("delete");
    expect(firstGuardrail(["SELECT 1", "GRANT SELECT ON a TO b"], "postgres")).toBe("grant");
    expect(firstGuardrail(["SELECT 1"], "postgres")).toBeNull();
    for (const key of [
      "delete",
      "delete_without_where",
      "update_without_where",
      "update_always_true",
      "drop",
      "truncate",
      "grant",
    ] as const) {
      expect(GUARDRAIL_LABEL[key].length).toBeGreaterThan(0);
    }
  });
});
