/**
 * The shared limiter's clause, transposed into the one order a Trino-family
 * grammar has.
 *
 * `SQLBaseProvider.prepareQuery()` appends `LIMIT n OFFSET m` for every page after
 * the first, and Trino's grammar is `[ OFFSET count ] [ LIMIT count ]` and only that
 * way round: measured on Trino 476, `... LIMIT 3 OFFSET 1` answers `line 1:47:
 * mismatched input 'OFFSET'. Expecting: <EOF>` while `... OFFSET 1 LIMIT 3` returns
 * the rows. Athena's engine is a Trino fork with the same clause order, so the two
 * providers share this one rewrite rather than each carrying a copy.
 *
 * The two clauses are transposed rather than rewritten from scratch: the limiter
 * already decided WHERE the clause goes, which is the hard part (before any trailing
 * comment, and never on a statement whose end cannot be cut), and the exact text it
 * emitted is known from the numbers it reports.
 *
 * Which occurrence to rewrite is decided by RECONSTRUCTION rather than by position,
 * and that is not defensive: the limiter deliberately inserts the clause BEFORE any
 * trailing comment (#280), so `lastIndexOf` finds the text inside the comment on a
 * statement that quotes its own bound, and `indexOf` finds a subquery's. Exactly one
 * occurrence is the appended one, because removing it - together with the single
 * space the limiter put in front of it - is what yields the original statement back.
 */

import type { PreparedQuery } from "@/lib/db/types";

/** Every index at which `needle` occurs in `haystack`, left to right. */
function occurrencesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);

  return found;
}

/**
 * `prepared` with its appended `LIMIT n OFFSET m` spelled `OFFSET m LIMIT n`, or
 * unchanged when the limiter appended nothing or no offset was asked for.
 *
 * `source` is the statement the limiter was given, which is what the
 * reconstruction compares against.
 */
export function offsetBeforeLimit(source: string, prepared: PreparedQuery): PreparedQuery {
  if (!prepared.wasLimited || prepared.offset === 0) return prepared;

  const emitted = `LIMIT ${prepared.limit} OFFSET ${prepared.offset}`;
  const transposed = `OFFSET ${prepared.offset} LIMIT ${prepared.limit}`;
  const trimmed = source.trim();
  // Non-null because the limiter built this string by inserting `emitted` into
  // `source`, so one occurrence always reconstructs it.
  const at = occurrencesOf(prepared.query, emitted).findLast(
    (index) => prepared.query.slice(0, index - 1) + prepared.query.slice(index + emitted.length) === trimmed,
  )!;

  return {
    ...prepared,
    query: prepared.query.slice(0, at) + transposed + prepared.query.slice(at + emitted.length),
  };
}
