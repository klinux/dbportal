import { NextRequest, NextResponse } from "next/server";
import { readTicket } from "@/lib/api/ticket";
import { statementTooLarge } from "@/lib/api/statement-size";
import { TRANSACTION_CONTROL_MESSAGE, firstTransactionControl } from "@/lib/sql/transaction-control";
import type { QueryPrepareOptions } from "@/lib/db/types";
import { capPrepareOptions, withConcurrency } from "@/lib/limits";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { isSelectQuery } from "@/lib/db/utils/query-limiter";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import type { DatabaseType, QueryWarning } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { auditExecution, type ExecutionAuditContext } from "@/lib/audit-execution";
import { assertObjectsAllowed } from "@/lib/api/object-gate";
import { assertWriteAllowed, providerAccessOptions } from "@/lib/api/write-gate";
import { maskResult, type MaskingContext } from "@/lib/masking/store";
import { clientAddress } from "@/lib/api/client-address";

export interface StatementResult {
  index: number;
  sql: string;
  startLine: number;
  status: "success" | "error";
  rows?: Record<string, unknown>[];
  fields?: string[];
  /** The columns the server masked in `rows` (docs/CONTEXT.md §4.7). */
  masked?: string[];
  rowCount?: number;
  executionTime: number;
  error?: string;
  /**
   * The two additive channels #273 gave the shared result, carried per statement
   * because that is where they are attributable: a notice belongs to the run that
   * produced it, and a declared type describes that run's own projection. Absent
   * when the engine reported none, never empty — the grid decides whether to
   * render anything from the field's presence alone (#285).
   */
  warnings?: QueryWarning[];
  columnTypes?: Record<string, string>;
}

/**
 * The channels a result carries beyond its rows, kept absent when the source has
 * none — the grid decides whether to render a section from the field's presence
 * alone, so an empty array would announce one with nothing in it (#285).
 *
 * Shared by the per-statement result and the main one, which is why it takes the
 * fields rather than a whole result: both shapes have exactly these two.
 */
function carriedChannels(source: Pick<StatementResult, "warnings" | "columnTypes"> | undefined) {
  return {
    ...(source?.warnings && { warnings: source.warnings }),
    ...(source?.columnTypes && { columnTypes: source.columnTypes }),
  };
}

/**
 * Run one statement of the script and describe the outcome, including the error
 * when it failed — the loop decides what to do about it.
 *
 * Extracted from `POST` rather than inlined: with the two channels added, the
 * handler carried the whole per-statement dance (limiter decision, execution,
 * error shaping) inside its own control flow and crossed the cognitive-complexity
 * bar (PR #308 review).
 */
async function runStatement(
  provider: DatabaseProvider,
  stmt: { sql: string; startLine: number },
  index: number,
  isLast: boolean,
  dialect: DatabaseType,
  options: QueryPrepareOptions,
  audit: Omit<ExecutionAuditContext, "statement">,
  masking: MaskingContext,
): Promise<StatementResult> {
  const startTime = performance.now();
  const identity = { index, sql: stmt.sql, startLine: stmt.startLine };

  try {
    // For the last statement that is a SELECT, apply limit. "Last statement
    // only" is this route's own policy; whether the statement IS a SELECT is
    // not — that reading is shared, and this route used to re-derive it with
    // `/^\s*SELECT\b/i`. `splitStatements` keeps each statement's leading
    // comments, so an annotated final SELECT failed that pattern and reached
    // the engine unprepared, which is the unbounded read the shared classifier
    // was made comment-tolerant to close (#281, #275). The shared reading also
    // types a `WITH` by the keyword its CTE list operates (#287), so a
    // read-only CTE is bounded here and a data-modifying one is not.
    const prepared =
      isLast && isSelectQuery(stmt.sql, dialect)
        ? provider.prepareQuery(stmt.sql, options)
        : { query: stmt.sql, wasLimited: false, limit: 0, offset: 0 };

    // One record per statement (docs/CONTEXT.md §4.2): each is its own execution, and a
    // script that failed on its third statement must say which one.
    const result = await auditExecution({ ...audit, statement: prepared.query }, () => provider.query(prepared.query));
    const served = await maskResult(result, {
      session: masking.session,
      connectionName: masking.connectionName,
      reveal: masking.reveal,
    });

    return {
      ...identity,
      status: "success",
      rows: served.rows,
      fields: served.fields,
      masked: served.masked,
      rowCount: result.rowCount,
      executionTime: Math.round(performance.now() - startTime),
      ...carriedChannels(result),
    };
  } catch (error) {
    return {
      ...identity,
      status: "error",
      executionTime: Math.round(performance.now() - startTime),
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/multi-query", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();
    const { sql, options = {} } = body;
    const ticket = readTicket(body.ticket);

    const connection = await resolveConnection(body, guard.session);

    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
    }
    const tooLarge = statementTooLarge(String(sql));
    if (tooLarge) return tooLarge;

    // The resolved connection's dialect, not the compatibility default: this is the
    // one surface that EXECUTES what the splitter returns, so a fragment invented by
    // a reading the engine does not share is a statement the operator never wrote.
    // Measured on postgres 18, `/* a /* b *\/ ; DROP TABLE t; -- *\/ SELECT 1` is one
    // read there and the flat reading made its second fragment a bare DROP (S1).
    const statements = splitStatements(sql, resolveSqlGrammar(connection.type));

    if (statements.length === 0) {
      return NextResponse.json({ error: "No valid SQL statements found" }, { status: 400 });
    }
    // Each statement of a script takes its own pooled connection (docs/CONTEXT.md §4.21): a
    // BEGIN here would open a transaction nobody closes. Refused whole, before any of it runs.
    if (
      firstTransactionControl(
        statements.map((s) => s.sql),
        connection.type,
      ) !== null
    ) {
      return NextResponse.json({ error: TRANSACTION_CONTROL_MESSAGE }, { status: 400 });
    }

    // The whole script is judged before any of it runs (§4.4): a script that writes on its
    // third statement must not run its first two on a datasource this session cannot write to.
    const access = await assertWriteAllowed({
      route: "POST /api/db/multi-query",
      session: guard.session,
      connection,
      statements: statements.map((statement) => statement.sql),
      request: req,
      ticket,
    });

    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(guard.session.username),
      ...providerAccessOptions(connection, guard.session),
    });
    // Every statement's objects must be this session's to use (docs/CONTEXT.md §4.56),
    // judged before the first one runs: a batch is refused whole, not half-executed.
    await assertObjectsAllowed({
      route: "POST /api/db/multi-query",
      session: guard.session,
      connection,
      statements: statements.map((statement) => statement.sql),
      request: req,
      provider,
    });
    const masking: MaskingContext = {
      session: guard.session,
      connectionName: connection.name,
      reveal: body.reveal === true,
    };
    const results: StatementResult[] = [];
    let totalExecutionTime = 0;
    const audit: Omit<ExecutionAuditContext, "statement"> = {
      route: "POST /api/db/multi-query",
      action: "multi-query",
      user: guard.session.username,
      connectionName: connection.name,
      ip: clientAddress(req),
      ...(ticket ? { ticket } : {}),
      ...access,
    };

    // The whole script is one of the person's running statements on the datasource
    // (§4.16), and the row cap holds the last SELECT the way it holds a single query.
    const capped = capPrepareOptions(options, connection.limits);
    await withConcurrency(connection, guard.session.username, async () => {
      for (let i = 0; i < statements.length; i++) {
        const outcome = await runStatement(
          provider,
          statements[i],
          i,
          i === statements.length - 1,
          connection.type,
          capped,
          audit,
          masking,
        );
        totalExecutionTime += outcome.executionTime;
        results.push(outcome);

        // Stop execution on error
        if (outcome.status === "error") break;
      }
    });

    // Return the last successful result with rows as the main result (for ResultsGrid)
    const lastResultWithRows = [...results]
      .reverse()
      .find((r) => r.status === "success" && r.rows && r.rows.length > 0);
    const hasError = results.some((r) => r.status === "error");

    return NextResponse.json({
      // Main result (for backward compatibility with ResultsGrid)
      rows: lastResultWithRows?.rows || [],
      fields: lastResultWithRows?.fields || [],
      rowCount: lastResultWithRows?.rowCount || 0,
      executionTime: totalExecutionTime,
      // The main result shows one statement's rows, so it carries that statement's
      // notices and declared types and no others. Merging every statement's
      // warnings here would attribute one run's notice to another run's rows.
      ...carriedChannels(lastResultWithRows),
      // Multi-statement metadata
      multiStatement: true,
      statementCount: statements.length,
      executedCount: results.length,
      hasError,
      statements: results,
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/multi-query" });
  }
}
