/**
 * The objects a statement names (docs/CONTEXT.md §4.56).
 *
 * The object rules of a datasource are enforced on statements, and enforcement needs
 * the names a statement reaches for: every relation after FROM, JOIN, INTO, UPDATE,
 * TABLE and the handful of other words that introduce one. This is a scanner over the
 * statement's CODE - comments, strings and quoted names are stepped over as the spans
 * the grammar declares them to be, so a table name inside a string literal is not a
 * reference and a quoted name with a space in it is one name - and not a parser: it does
 * not know the statement's structure, only where a relation can be spelled.
 *
 * That is the right tool for a REFUSAL and the wrong tool for a permission, so the
 * design errs the one way it may. Whatever it finds is checked; what it cannot read it
 * says so about, and the gate refuses the statement rather than guessing: a statement
 * whose leading keyword is not one whose reach this scanner knows (`CALL`, `COPY`,
 * `LOAD DATA`, a vendor extension) is `opaque`, and a name carrying a wildcard (a search
 * cluster's `logs-*`) is reported with it so the gate can refuse it. A false positive
 * costs a person a qualified name or a rewritten statement; a false negative would be a
 * hidden object read, which is the thing the rules exist to prevent.
 *
 * Common-table-expression names are collected first and excluded, so `WITH recent AS
 * (...) SELECT * FROM recent` names only what `recent` was built from.
 */
import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "./grammar";
import { readSqlSpan } from "./spans";
import { readSqlWord } from "./words";

export interface ReferencedObject {
  /** The qualifier segments as written - `["public"]`, `["db", "dbo"]` - empty when unqualified. */
  readonly qualifier: readonly string[];
  readonly name: string;
  /** True when the name (or a qualifier) carries a `*`, which names objects rather than one. */
  readonly wildcard: boolean;
}

export interface ReferencedObjects {
  readonly references: readonly ReferencedObject[];
  /** Set when the statement's reach cannot be read; names the leading keyword that made it so. */
  readonly opaque?: string;
}

/** Leading keywords whose statements reach only what this scanner can find. */
const READABLE_LEADING = new Set([
  "SELECT",
  "WITH",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "REPLACE",
  "UPSERT",
  "VALUES",
  "TABLE",
  "EXPLAIN",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "ANALYZE",
  "ANALYSE",
  "VACUUM",
  "REINDEX",
  "LOCK",
  "REFRESH",
  "CLUSTER",
  "OPTIMIZE",
  "CHECK",
  "CHECKSUM",
  "REPAIR",
  "FLUSH",
  "KILL",
  "SET",
  "RESET",
  "USE",
  "BEGIN",
  "START",
  "COMMIT",
  "ROLLBACK",
  "END",
  "SAVEPOINT",
  "RELEASE",
  "CHECKPOINT",
]);

/** Words after which the next name is a relation. */
const INTRODUCERS = new Set([
  "FROM",
  "DROP",
  "JOIN",
  "INTO",
  "UPDATE",
  "TABLE",
  "TRUNCATE",
  "DESCRIBE",
  "USING",
  "LOCK",
  "VACUUM",
  "ANALYZE",
  "ANALYSE",
  "REINDEX",
  "CLUSTER",
  "OPTIMIZE",
  "REPAIR",
  "CHECKSUM",
]);

/** Words that may sit between an introducer and the name without being one. */
const SKIPPABLE = new Set([
  "TABLE",
  "TABLES",
  "ONLY",
  "IF",
  "NOT",
  "EXISTS",
  "TEMP",
  "TEMPORARY",
  "UNLOGGED",
  "LATERAL",
  "FULL",
  "VERBOSE",
  "ANALYZE",
  "ANALYSE",
  "FREEZE",
  "MATERIALIZED",
  "VIEW",
  "INDEX",
  "CONCURRENTLY",
  "OR",
  "REPLACE",
  "EXTERNAL",
  "GLOBAL",
  "LOCAL",
  "INTO",
]);

/** A word in name position that is not a name: the start of something else. */
const NOT_A_NAME = new Set([
  "SELECT",
  "VALUES",
  "UNNEST",
  "DUAL",
  "WITH",
  "NULL",
  "DEFAULT",
  "NEW",
  "OLD",
  "OUTFILE",
  "DUMPFILE",
  "ROWS",
  "ROW",
  "NEXT",
  "FIRST",
  "LAST",
]);

/** Clause words that end a relation list, so a word before a comma is an alias only when it is not one of these. */
const CLAUSE_WORDS = new Set([
  "WHERE",
  "ON",
  "USING",
  "SET",
  "GROUP",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "HAVING",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "RETURNING",
  "FETCH",
  "FOR",
  "WINDOW",
  "QUALIFY",
  "VALUES",
  "SELECT",
  "AS",
  "WITH",
  "STRAIGHT_JOIN",
  "PARTITION",
  "TABLESAMPLE",
  "MATCH",
  "WHEN",
  "OUTPUT",
  "OPTION",
  "INTO",
]);

const DIGIT = /\p{N}/u;
const NUMBER_PART = /[\p{N}\p{L}_]/u;

/** Introducers after which a comma at the same depth names another relation. */
const LIST_OPENERS = new Set(["FROM", "UPDATE", "TRUNCATE", "DROP", "LOCK"]);

/** Words that end a relation list at their depth. */
const LIST_TERMINATORS = new Set([
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "SET",
  "WINDOW",
  "QUALIFY",
  "FETCH",
  "FOR",
  "RETURNING",
  "VALUES",
  "SELECT",
  "WITH",
  "WHEN",
  "OUTPUT",
  "OPTION",
  "ADD",
  "ALTER",
  "MODIFY",
  "RENAME",
  "IN",
  "READ",
  "WRITE",
]);

interface WordToken {
  readonly kind: "word";
  readonly text: string;
  readonly upper: string;
  readonly start: number;
  readonly end: number;
}
interface NameToken {
  readonly kind: "name";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
interface PunctToken {
  readonly kind: "punct";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
type Token = WordToken | NameToken | PunctToken;

function unquote(span: string): string {
  const open = span[0];
  const close = open === "[" ? "]" : open;
  const inner = span.length >= 2 && span.endsWith(close) ? span.slice(1, -1) : span.slice(1);
  return open === "[" ? inner : inner.split(close + close).join(close);
}

function tokenize(sql: string, grammar: SqlGrammar): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, grammar);
    if (span !== null) {
      if (span.kind === "quoted-identifier") {
        tokens.push({ kind: "name", text: unquote(sql.slice(index, span.end)), start: index, end: span.end });
      }
      index = span.end;
      continue;
    }
    const word = readSqlWord(sql, index);
    if (word !== null) {
      tokens.push({ kind: "word", text: sql.slice(index, word.end), upper: word.text, start: index, end: word.end });
      index = word.end;
      continue;
    }
    // A number is one token too: `logs-2026` on a search cluster is a name whose second
    // half no identifier reader accepts, and it must be glued back on as one piece.
    if (DIGIT.test(sql[index])) {
      let end = index + 1;
      while (end < sql.length && NUMBER_PART.test(sql[end])) end += 1;
      tokens.push({ kind: "word", text: sql.slice(index, end), upper: sql.slice(index, end).toUpperCase(), start: index, end });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", text: sql[index], start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function isWord(token: Token | undefined, upper: string): boolean {
  return token !== undefined && token.kind === "word" && token.upper === upper;
}

function isSkippable(token: Token | undefined): boolean {
  return token !== undefined && token.kind === "word" && SKIPPABLE.has(token.upper);
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === "punct" && token.text === text;
}

/** The index just past the parenthesised group opening at `open`, or the token count when unbalanced. */
function skipGroup(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isPunct(tokens[i], "(")) depth += 1;
    else if (isPunct(tokens[i], ")")) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

/** The names a WITH clause defines, so they are not taken for objects. */
function cteNames(tokens: readonly Token[]): Set<string> {
  const names = new Set<string>();
  let i = 0;
  if (!isWord(tokens[i], "WITH")) return names;
  i += 1;
  if (isWord(tokens[i], "RECURSIVE")) i += 1;
  for (;;) {
    const name = tokens[i];
    if (name === undefined || name.kind === "punct") return names;
    names.add(name.text.toLowerCase());
    i += 1;
    if (isPunct(tokens[i], "(")) i = skipGroup(tokens, i);
    if (!isWord(tokens[i], "AS")) return names;
    i += 1;
    // NOT MATERIALIZED / MATERIALIZED sit between AS and the body.
    while (tokens[i]?.kind === "word") i += 1;
    if (!isPunct(tokens[i], "(")) return names;
    i = skipGroup(tokens, i);
    if (!isPunct(tokens[i], ",")) return names;
    i += 1;
  }
}

/**
 * A dotted name starting at `at`: `a`, `a.b`, `"a".b`, and on a search cluster `logs-*`
 * (a hyphen or a star glued to the name continues it, and the star marks it a wildcard).
 * Null when no name starts there.
 */
function readName(tokens: readonly Token[], at: number): { reference: ReferencedObject; next: number } | null {
  const segments: string[] = [];
  let wildcard = false;
  let i = at;
  for (;;) {
    let token = tokens[i];
    if (token === undefined || token.kind === "punct") {
      // `schema.*`: everything in the container, which is a wildcard reference.
      if (segments.length > 0 && isPunct(token, "*")) {
        segments.push("*");
        wildcard = true;
        i += 1;
      }
      break;
    }
    let text = token.text;
    let end = token.end;
    if (text.includes("*")) wildcard = true;
    i += 1;
    // Glued continuation: `logs-2026`, `logs-*`, `apim*`. A star is part of the name only
    // when it touches it, so `SELECT a.*` and `count(*)` are untouched.
    for (;;) {
      token = tokens[i];
      if (token === undefined || token.start !== end) break;
      if (token.kind === "punct" && (token.text === "-" || token.text === "*")) {
        if (token.text === "*") wildcard = true;
        text += token.text;
        end = token.end;
        i += 1;
        continue;
      }
      if (token.kind !== "punct" && (text.endsWith("-") || text.endsWith("*"))) {
        text += token.text;
        end = token.end;
        i += 1;
        continue;
      }
      break;
    }
    segments.push(text);
    if (!isPunct(tokens[i], ".")) break;
    i += 1;
  }
  if (segments.length === 0) return null;
  const name = segments[segments.length - 1];
  return { reference: { qualifier: segments.slice(0, -1), name, wildcard }, next: i };
}

/**
 * Every object the statement names, or `opaque` when its reach cannot be read.
 *
 * `grammar` is the dialect's reading of quotes and comments, the same one the splitter
 * and the classifiers take; pass the connection's, resolved once.
 */
export function referencedObjects(sql: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): ReferencedObjects {
  const tokens = tokenize(sql, grammar);
  const leading = tokens.find((token) => !isPunct(token, "("));
  if (leading === undefined) return { references: [] };
  if (leading.kind !== "word" || !READABLE_LEADING.has(leading.upper)) {
    return { references: [], opaque: leading.kind === "word" ? leading.upper : leading.text };
  }
  const ctes = cteNames(tokens);
  const references: ReferencedObject[] = [];
  const seen = new Set<string>();

  const take = (found: ReferencedObject): void => {
    if (found.qualifier.length === 0 && ctes.has(found.name.toLowerCase())) return;
    const key = [...found.qualifier, found.name].join("/").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    references.push(found);
  };

  /**
   * One name in relation position, taken unless it is a call (`FROM json_each(x)`,
   * `FROM t(alias)`) after an introducer that never takes a column list; the index past it.
   */
  const readListed = (at: number, introducer: string): number => {
    const first = tokens[at];
    if (first === undefined || first.kind === "punct") return at;
    if (first.kind === "word" && (NOT_A_NAME.has(first.upper) || CLAUSE_WORDS.has(first.upper))) return at;
    const read = readName(tokens, at);
    if (read === null) return at;
    const callLike = isPunct(tokens[read.next], "(") && (introducer === "FROM" || introducer === "JOIN");
    if (!callLike) take(read.reference);
    return read.next;
  };

  let i = 0;
  let depth = 0;
  /**
   * The relation lists being read, innermost last: `FROM a, (SELECT * FROM b) s, c` is
   * two, and the outer one resumes at `, c` once the inner one closed with its paren.
   */
  const lists: { depth: number; opener: string }[] = [];
  const list = (): { depth: number; opener: string } | undefined => lists[lists.length - 1];
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (token.kind === "punct") {
      if (token.text === "(") depth += 1;
      else if (token.text === ")") {
        depth -= 1;
        while (list() !== undefined && list()!.depth > depth) lists.pop();
      } else if (token.text === "," && list()?.depth === depth) {
        // The list continues past whatever sat between the last name and the comma - an
        // alias, a TABLESAMPLE, a join condition - so nothing between is modelled.
        i = readListed(i, list()!.opener);
      }
      continue;
    }
    if (token.kind !== "word") continue;
    if (list()?.depth === depth && LIST_TERMINATORS.has(token.upper)) lists.pop();
    // DESC introduces a name only as the statement's own verb; elsewhere it is ORDER BY's.
    const introducer = INTRODUCERS.has(token.upper) || (token.upper === "DESC" && token === leading);
    if (!introducer) continue;
    // `JOIN t USING (a, b)` names columns; `MERGE INTO t USING s` names a relation.
    if (isPunct(tokens[i], "(")) continue;
    while (isSkippable(tokens[i])) i += 1;
    i = readListed(i, token.upper);
    if (LIST_OPENERS.has(token.upper)) {
      if (list()?.depth === depth) lists.pop();
      lists.push({ depth, opener: token.upper });
    }
  }
  return { references };
}
