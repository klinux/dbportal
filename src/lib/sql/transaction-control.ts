import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import type { DatabaseType } from "@/lib/types";

/**
 * Transaction control written as a statement (docs/CONTEXT.md §4.21): BEGIN, START
 * TRANSACTION, COMMIT, ROLLBACK, SAVEPOINT, RELEASE, END. The plain execution routes take a
 * connection from the pool for each statement and hand it back after, so a BEGIN written
 * there opens a transaction on a connection the next statement - or the next person -
 * gets at random, and it is never closed by the COMMIT that follows on another. The
 * studio's transaction mode (`/api/db/transaction`) keeps one connection for the whole of
 * it; this reader lets the plain routes refuse the shape and say so.
 */
const CONTROL = new Set(["BEGIN", "START", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END"]);

export const TRANSACTION_CONTROL_MESSAGE =
  "A statement cannot open or close a transaction here: each statement runs on its own pooled connection. Use the transaction mode for a script that must run as one transaction.";

export function isTransactionControl(sql: string, type?: DatabaseType): boolean {
  if (!readsSqlText(type)) return false;
  const leading = readLeadingKeyword(sql, resolveSqlGrammar(type));
  return leading !== null && CONTROL.has(leading.keyword);
}

/** The first statement that is transaction control, or null. */
export function firstTransactionControl(statements: readonly string[], type?: DatabaseType): string | null {
  return statements.find((sql) => isTransactionControl(sql, type)) ?? null;
}
