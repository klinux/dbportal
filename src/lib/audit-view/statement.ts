import { format as formatSql } from "sql-formatter";

/**
 * How the admin Audit page shows a recorded statement (requested 2026-09-14): one line for
 * the row, as the History tab does, and the whole of it formatted when unfolded.
 */
export const STATEMENT_OVERVIEW_CHARS = 140;

/** The statement on one line, cut with an ellipsis past the overview length. */
export function statementOverview(statement: string): string {
  const oneLine = statement.replace(/\s+/g, " ").trim();
  return oneLine.length > STATEMENT_OVERVIEW_CHARS ? `${oneLine.slice(0, STATEMENT_OVERVIEW_CHARS)}…` : oneLine;
}

/** The statement formatted the way the editor's Format button does it; the text itself when the formatter refuses it. */
export function formatStatement(statement: string): string {
  try {
    return formatSql(statement, {
      language: "sql",
      keywordCase: "upper",
      indentStyle: "standard",
      logicalOperatorNewline: "before",
      expressionWidth: 100,
      tabWidth: 2,
    });
  } catch {
    return statement;
  }
}
