import { NextRequest, NextResponse } from "next/server";
import { capPrepareOptions, withConcurrency } from "@/lib/limits";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditExecution, type ExecutionAction } from "@/lib/audit-execution";
import { assertWriteAllowed, providerAccessOptions, type WriteAccess } from "@/lib/api/write-gate";
import { maskResult } from "@/lib/masking/store";
import { clientAddress } from "@/lib/api/client-address";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";

interface TransactionProvider {
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  isInTransaction(): boolean;
  queryInTransaction(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields: string[]; rowCount: number; executionTime: number }>;
}

function isTransactionProvider(provider: unknown): provider is TransactionProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "beginTransaction" in provider &&
    "commitTransaction" in provider &&
    "rollbackTransaction" in provider
  );
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/transaction", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();
    const { action, sql, options = {} } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!action) {
      return NextResponse.json({ error: "Connection and action are required" }, { status: 400 });
    }

    // Only the statement writes; begin, commit and rollback are the envelope (§4.4).
    let access: WriteAccess = {};
    if (action === "query" && typeof sql === "string") {
      access = await assertWriteAllowed({
        route: "POST /api/db/transaction",
        session: guard.session,
        connection,
        statements: [sql],
        request: req,
      });
    }

    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(guard.session.username),
      ...providerAccessOptions(connection, guard.session),
    });

    if (!isTransactionProvider(provider)) {
      return NextResponse.json(
        { error: "Transaction control is not supported for this database type" },
        { status: 400 },
      );
    }

    // Every action that touches the database is recorded (docs/CONTEXT.md §4.2): the
    // three control statements without a statement text, the query with its own.
    const audited = <T>(step: ExecutionAction, invoke: () => Promise<T>, statement?: string) =>
      auditExecution(
        {
          route: "POST /api/db/transaction",
          action: step,
          user: guard.session.username,
          connectionName: connection.name,
          ip: clientAddress(req),
          ...(statement !== undefined ? { statement } : {}),
          ...access,
        },
        invoke,
      );

    switch (action) {
      case "begin": {
        await audited("transaction:begin", () => provider.beginTransaction());
        return NextResponse.json({ status: "active", message: "Transaction started" });
      }

      case "commit": {
        await audited("transaction:commit", () => provider.commitTransaction());
        return NextResponse.json({ status: "committed", message: "Transaction committed" });
      }

      case "rollback": {
        await audited("transaction:rollback", () => provider.rollbackTransaction());
        return NextResponse.json({ status: "rolled_back", message: "Transaction rolled back" });
      }

      case "query": {
        if (!sql) {
          return NextResponse.json({ error: "SQL query is required for transaction query" }, { status: 400 });
        }

        // The values of a generated statement are bound here as well: a row edit
        // applied while a transaction is open takes this endpoint, and it would
        // otherwise be the one path that still carried them as text (#290).
        const bound = readBoundParams(body.params);
        if (!bound.valid) {
          return NextResponse.json({ error: bound.message }, { status: 400 });
        }

        // Apply limit for SELECT queries within transaction, within the datasource's cap (§4.16).
        const prepared = provider.prepareQuery(sql, capPrepareOptions(options, connection.limits));
        const result = await withConcurrency(connection, guard.session.username, () =>
          audited("transaction:query", () => provider.queryInTransaction(prepared.query, bound.params), prepared.query),
        );

        const hasMore = result.rows.length === prepared.limit;
        // Masked before it leaves (docs/CONTEXT.md §4.7), like the query route.
        const served = await maskResult(result, {
          session: guard.session,
          connectionName: connection.name,
          reveal: body.reveal === true,
        });

        return NextResponse.json({
          ...served,
          inTransaction: true,
          pagination: {
            limit: prepared.limit,
            offset: prepared.offset,
            hasMore,
            totalReturned: result.rows.length,
            wasLimited: prepared.wasLimited,
          },
        });
      }

      case "status": {
        return NextResponse.json({
          inTransaction: provider.isInTransaction(),
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown transaction action: ${action}. Valid: begin, commit, rollback, query, status` },
          { status: 400 },
        );
    }
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/transaction" });
  }
}
