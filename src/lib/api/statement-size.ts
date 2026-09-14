import { NextResponse } from "next/server";

/**
 * How much statement text one request may carry (docs/CONTEXT.md §4.21). Not a limit on
 * what a datasource can run - an `UPDATE … WHERE id IN (…)` of two thousand ids is twenty
 * kilobytes - but the bound above which the readers that classify a statement before it
 * runs (the splitter, the read-only gate, the guardrails) would be asked to scan text no
 * person wrote by hand. One mebibyte; answered as 413, never partially run.
 */
export const SQL_MAX_CHARS = 1_048_576;

export function statementTooLarge(sql: string): NextResponse | null {
  if (sql.length <= SQL_MAX_CHARS) return null;
  return NextResponse.json(
    {
      error: `The statement is ${sql.length} characters; at most ${SQL_MAX_CHARS} may be sent in one request`,
      statusCode: 413,
    },
    { status: 413 },
  );
}
