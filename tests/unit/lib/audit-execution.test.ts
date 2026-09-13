import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { auditExecution, executionFailureReason } from "@/lib/audit-execution";
import { getServerAuditBuffer } from "@/lib/audit";
import {
  AuthenticationError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { logger } from "@/lib/logger";

/**
 * The audit line for a human execution (docs/CONTEXT.md §4.2). Read from the stdout line
 * and the ring buffer both, because the two are the two destinations an operator has.
 */
const context = {
  route: "POST /api/db/query",
  action: "query" as const,
  user: "user@example.test",
  connectionName: "Orders (staging)",
  statement: "SELECT * FROM orders WHERE token = 'hunter2'",
  ip: "203.0.113.9",
};

function lines(logSpy: ReturnType<typeof spyOn>): Record<string, unknown>[] {
  return (logSpy.mock.calls as unknown[][])
    .map((call) => call[0])
    .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
    .map((v) => JSON.parse(v) as Record<string, unknown>)
    .filter((l) => l.event === "query_execution");
}

describe("auditExecution", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.AUDIT_INCLUDE_SQL;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUDIT_INCLUDE_SQL;
  });

  test("records a success with the person, the datasource, the duration and the address - and no statement by default", async () => {
    const result = await auditExecution(context, async () => ({ rows: [1] }));
    expect(result).toEqual({ rows: [1] });

    const [line] = lines(logSpy);
    expect(line).toMatchObject({
      event: "query_execution",
      action: "query",
      outcome: "success",
      actor: "user@example.test",
      route: "POST /api/db/query",
      connection: "Orders (staging)",
      ip: "203.0.113.9",
    });
    expect(typeof line.duration_ms).toBe("number");
    // Off by default: SQL can quote a secret in a literal.
    expect(line.statement).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("hunter2");
    const buffered = getServerAuditBuffer().getRecent(1)[0];
    expect(buffered.details).toBeUndefined();
  });

  test("records the statement, bounded and redacted, only when AUDIT_INCLUDE_SQL=true", async () => {
    process.env.AUDIT_INCLUDE_SQL = "true";
    await auditExecution(
      { ...context, statement: `SELECT 'postgres://u:p@db:5432/app' AS uri, '${"x".repeat(400)}'` },
      async () => 1,
    );
    const [line] = lines(logSpy);
    expect(typeof line.statement).toBe("string");
    expect(line.statement as string).toContain("SELECT");
    expect(line.statement as string).not.toContain("u:p@");
    expect((line.statement as string).length).toBeLessThanOrEqual(254);
  });

  test("an unrecognised flag value keeps the statement off the record", async () => {
    process.env.AUDIT_INCLUDE_SQL = "yes";
    await auditExecution(context, async () => 1);
    expect(lines(logSpy)[0].statement).toBeUndefined();
  });

  // The reason is a closed value from the error's class; the message - which may quote the
  // statement or the server's reply - never reaches the record. The error itself is rethrown
  // untouched so the route's own error mapping still answers it.
  test("records a failure with a closed reason and rethrows the error untouched", async () => {
    const failure = new QueryError("syntax error at 'hunter2'", "postgres");
    await expect(
      auditExecution(context, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [line] = lines(logSpy);
    expect(line.outcome).toBe("failure");
    expect(line.reason).toBe("query_error");
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  test("a control step with no statement records none, flag or not", async () => {
    process.env.AUDIT_INCLUDE_SQL = "true";
    const { statement: _statement, ...control } = context;
    await auditExecution({ ...control, action: "transaction:begin" }, async () => undefined);
    const [line] = lines(logSpy);
    expect(line.action).toBe("transaction:begin");
    expect(line).not.toHaveProperty("statement");
    expect(line).not.toHaveProperty("ip", undefined);
  });

  test("omits the address when the caller has none", async () => {
    const { ip: _ip, ...noIp } = context;
    await auditExecution(noIp, async () => 1);
    expect(lines(logSpy)[0].ip).toBeUndefined();
  });

  // A broken sink must never turn an execution that already finished into a 500.
  test("a failing audit sink is logged and the execution's result still returns", async () => {
    logSpy.mockImplementation(() => {
      throw new Error("stdout closed");
    });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await auditExecution(context, async () => "done")).toBe("done");
      expect(errorSpy).toHaveBeenCalledWith("Failed to record query_execution audit event", expect.any(Error), {
        route: "POST /api/db/query",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("executionFailureReason", () => {
  test("maps each driver error class to its closed reason, and anything else to execution_failed", () => {
    expect(executionFailureReason(new QueryCancelledError("c", "postgres"))).toBe("query_cancelled");
    expect(executionFailureReason(new TimeoutError("t", "postgres", 1000))).toBe("query_timeout");
    expect(executionFailureReason(new AuthenticationError("a", "postgres"))).toBe("database_auth_error");
    expect(executionFailureReason(new DatabaseConfigError("c", "postgres"))).toBe("database_config_error");
    expect(executionFailureReason(new QueryError("q", "postgres"))).toBe("query_error");
    expect(executionFailureReason(new Error("boom"))).toBe("execution_failed");
    expect(executionFailureReason("not even an error")).toBe("execution_failed");
  });
});
