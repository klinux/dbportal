import { describe, test, expect } from "bun:test";
import { referencedObjects } from "@/lib/sql/referenced-objects";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

/**
 * The scanner behind the object gate (docs/CONTEXT.md §4.56): every relation a statement
 * reaches for, none of the words that only look like one, and "opaque" for the statements
 * whose reach it cannot read - because a name it misses is a hidden object read.
 */
function names(sql: string, type?: Parameters<typeof resolveSqlGrammar>[0]): string[] {
  const found = referencedObjects(sql, type === undefined ? undefined : resolveSqlGrammar(type));
  if (found.opaque !== undefined) return [`opaque:${found.opaque}`];
  return found.references.map((r) => [...r.qualifier, r.name].join(".") + (r.wildcard ? "{*}" : ""));
}

describe("relations after the words that introduce one", () => {
  test("FROM, JOIN, INTO, UPDATE and DELETE FROM, qualified or not", () => {
    expect(names("SELECT * FROM orders")).toEqual(["orders"]);
    expect(names("select o.id from public.orders o join public.customers as c on c.id = o.cid")).toEqual([
      "public.orders",
      "public.customers",
    ]);
    expect(names("INSERT INTO public.orders (id, name) VALUES (1, 'FROM secret')")).toEqual(["public.orders"]);
    expect(names("UPDATE orders SET a = 1 FROM customers c WHERE c.id = orders.cid")).toEqual(["orders", "customers"]);
    expect(names("DELETE FROM only orders WHERE id IN (SELECT id FROM \"Old Orders\")")).toEqual(["orders", "Old Orders"]);
    expect(names("SELECT * FROM db.schema.tbl")).toEqual(["db.schema.tbl"]);
  });

  test("DDL and maintenance verbs, with the words that sit between them and the name", () => {
    expect(names("TRUNCATE TABLE orders, audit.log")).toEqual(["orders", "audit.log"]);
    expect(names("CREATE TABLE IF NOT EXISTS public.new_t (id int)")).toEqual(["public.new_t"]);
    expect(names("DROP TABLE IF EXISTS a, b.c")).toEqual(["a", "b.c"]);
    expect(names("ALTER TABLE t ADD a int, ADD b int")).toEqual(["t"]);
    expect(names("SHOW CREATE TABLE orders")).toEqual(["orders"]);
    expect(names("DESCRIBE orders")).toEqual(["orders"]);
    expect(names("DESC orders")).toEqual(["orders"]);
    expect(names("VACUUM ANALYZE public.big")).toEqual(["public.big"]);
    expect(names("LOCK TABLE a, b IN ACCESS SHARE MODE")).toEqual(["a", "b"]);
    expect(names("EXPLAIN ANALYZE SELECT * FROM orders")).toEqual(["orders"]);
    expect(names("MERGE INTO target t USING source s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1")).toEqual([
      "target",
      "source",
    ]);
  });

  test("a relation list continues past aliases, samples and join conditions, at its own depth", () => {
    expect(names("SELECT count(*) FROM t1 t, t2 AS u, t3")).toEqual(["t1", "t2", "t3"]);
    expect(names("SELECT * FROM t1 TABLESAMPLE SYSTEM (10), t2")).toEqual(["t1", "t2"]);
    expect(names("SELECT * FROM a JOIN b ON a.x = b.x, c")).toEqual(["a", "b", "c"]);
    expect(names("UPDATE a, b SET a.x = b.x")).toEqual(["a", "b"]);
    expect(names("select * from t1 as x, t2 y, (select 1) z, t3")).toEqual(["t1", "t2", "t3"]);
    expect(names("SELECT * FROM a, (SELECT * FROM b WHERE x IN (SELECT y FROM d)) s, c")).toEqual(["a", "b", "d", "c"]);
    // A comma in a select list, a WHERE, an ORDER BY or a SET is not a relation list.
    expect(names("SELECT a, b FROM t1 WHERE c IN (1, 2) ORDER BY a, b")).toEqual(["t1"]);
    expect(names("UPDATE t SET a = 1, b = 2 WHERE id = 3")).toEqual(["t"]);
    expect(names("SELECT (SELECT count(*) FROM x), 2 FROM y")).toEqual(["x", "y"]);
    expect(names("INSERT INTO t VALUES (1, 2), (3, 4)")).toEqual(["t"]);
  });

  test("subqueries anywhere are read; a call after FROM is not a relation", () => {
    expect(names("SELECT * FROM (SELECT * FROM inner_t) s")).toEqual(["inner_t"]);
    expect(names("SELECT * FROM t WHERE x IN (SELECT y FROM u) AND z = (SELECT MAX(q) FROM v)")).toEqual(["t", "u", "v"]);
    expect(names("(SELECT 1 FROM x) UNION (SELECT 2 FROM y)")).toEqual(["x", "y"]);
    expect(names("SELECT * FROM a CROSS JOIN LATERAL (SELECT * FROM b) x")).toEqual(["a", "b"]);
    expect(names("SELECT * FROM json_each('[1]') j, generate_series(1,3)")).toEqual([]);
    // `USING (cols)` names columns; a word in name position that starts something else is skipped.
    expect(names("SELECT * FROM t1 JOIN t2 USING (id)")).toEqual(["t1", "t2"]);
    expect(names("SELECT * FROM t1 JOIN LATERAL unnest(x) u ON true")).toEqual(["t1"]);
    expect(names("INSERT INTO t SELECT * FROM s")).toEqual(["t", "s"]);
  });

  test("a CTE name is not an object, in every spelling of a WITH clause", () => {
    expect(
      names(
        "WITH recent AS (SELECT * FROM orders WHERE x = 1), agg (a) AS MATERIALIZED (SELECT 1 FROM recent) SELECT * FROM recent, agg r, audit.log",
      ),
    ).toEqual(["orders", "audit.log"]);
    expect(names("WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r")).toEqual([]);
    // A malformed WITH stops the CTE read where it stops making sense, and the rest is scanned.
    expect(names("WITH x SELECT * FROM t")).toEqual(["t"]);
    expect(names("WITH x AS SELECT * FROM t")).toEqual(["t"]);
    expect(names("WITH x AS (SELECT * FROM t")).toEqual(["t"]);
    expect(names("WITH")).toEqual([]);
    expect(names("WITH (a) AS (SELECT 1) SELECT * FROM t")).toEqual(["t"]);
  });
});

describe("what is stepped over", () => {
  test("comments and strings hold no relation, and a quoted name is one name", () => {
    expect(names("SELECT * FROM t /* FROM hidden */ WHERE a = 'FROM hidden2' -- FROM hidden3")).toEqual(["t"]);
    expect(names("select * from `db`.`tbl` -- from nothing", "mysql")).toEqual(["db.tbl"]);
    expect(names("select * from [dbo].[Order Lines] as ol", "mssql")).toEqual(["dbo.Order Lines"]);
    expect(names('SELECT * FROM "a""b"')).toEqual(['a"b']);
    // An unterminated quote is a name to its end rather than a crash.
    expect(names('SELECT * FROM "unterminated')).toEqual(["unterminated"]);
  });

  test("`a.*` and `count(*)` are not wildcard names; ORDER BY DESC is not a DESCRIBE", () => {
    expect(names("SELECT a.* FROM a")).toEqual(["a"]);
    expect(names("SELECT count(*) FROM a ORDER BY b DESC")).toEqual(["a"]);
  });

  test("a statement with nothing to name, or nothing at all", () => {
    expect(names("SHOW TABLES")).toEqual([]);
    expect(names("SELECT 1")).toEqual([]);
    expect(names("")).toEqual([]);
    expect(names("   ")).toEqual([]);
    expect(names("(")).toEqual([]);
    expect(names("SELECT * FROM")).toEqual([]);
    expect(names("SELECT * FROM (")).toEqual([]);
    expect(names("SELECT * FROM 42")).toEqual(["42"]);
  });
});

describe("what is refused rather than guessed", () => {
  test("a leading keyword whose reach is unknown makes the statement opaque", () => {
    expect(names("CALL do_stuff()")).toEqual(["opaque:CALL"]);
    expect(names("COPY orders TO '/tmp/x'")).toEqual(["opaque:COPY"]);
    expect(names("SYS COLUMNS")).toEqual(["opaque:SYS"]);
    expect(names("EXEC sp_who")).toEqual(["opaque:EXEC"]);
    // Not a word at all in the lead: reported as the character.
    expect(names("42")).toEqual(["opaque:42"]);
    expect(names("; SELECT 1")).toEqual(["opaque:;"]);
  });

  test("a search cluster's glued names, and the wildcard in them", () => {
    expect(names("SELECT * FROM logs-2026* WHERE 1=1")).toEqual(["logs-2026*{*}"]);
    expect(names("SELECT * FROM logs-2026.09*")).toEqual(["logs-2026.09*{*}"]);
    expect(names("SELECT * FROM apim-data")).toEqual(["apim-data"]);
    expect(names("SELECT * FROM apim-data-2")).toEqual(["apim-data-2"]);
    expect(names('SELECT * FROM "logs-*"')).toEqual(["logs-*{*}"]);
    expect(names("SELECT * FROM public.*")).toEqual(["public.*{*}"]);
    expect(names("SELECT * FROM a - b")).toEqual(["a"]);
  });

  test("the same relation named twice is reported once", () => {
    expect(names("SELECT * FROM t JOIN t ON 1 = 1")).toEqual(["t"]);
    expect(names("SELECT * FROM T, t")).toEqual(["T"]);
  });
});
