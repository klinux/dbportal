import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ApprovalQuery, ApprovalRequest } from "@/lib/storage/types";
import type { ServiceIdentity } from "@/lib/service-tokens/types";

/**
 * The execution queue (docs/CONTEXT.md §4.10): what a bot's request must carry, what the
 * token and the datasource allow, when it runs at once and when it waits, what a run
 * stores (masked, bounded, audited with the token as actor and the person as subject),
 * and what a reviewer's decision sets in motion. Storage, the datasource resolver, the
 * provider, masking, the notifier and the token store are mocked.
 */
let rows = new Map<string, ApprovalRequest>();
let enabled = true;
const provider = {
  putApproval: mock(async (record: ApprovalRequest) => {
    rows.set(record.id, { ...record });
  }),
  getApproval: mock(async (id: string) => rows.get(id) ?? null),
  listApprovals: mock(async (query: ApprovalQuery) => [...rows.values()].slice(0, query.limit)),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled ? provider : null),
}));

class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}
const datasources: Record<string, Record<string, unknown>> = {
  orders: { id: "orders", seedId: "orders", name: "Orders", type: "postgres", roles: ["*"], writeApproval: true },
  plain: { id: "plain", seedId: "plain", name: "Plain", type: "postgres", roles: ["*"] },
  locked: { id: "locked", seedId: "locked", name: "Locked", type: "postgres", roles: ["*"], writeRoles: ["admin"] },
  two: {
    id: "two",
    seedId: "two",
    name: "Two",
    type: "postgres",
    roles: ["*"],
    writeApproval: true,
    approvalsRequired: 2,
  },
};
// Flipped by one test: the datasource refuses the token at run time (mock.module is
// process-wide, so the mock is switched by a flag rather than re-registered).
let denyAll = false;
mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: async (body: { connectionId?: string }) => {
    if (denyAll) throw new SeedConnectionError("Access denied", 403);
    const id = (body.connectionId ?? "").replace(/^seed:/, "");
    const found = datasources[id];
    if (!found) throw new SeedConnectionError(`Datasource "${id}" not found`, 404);
    return found;
  },
}));

let queryResult: { rows: Record<string, unknown>[]; fields: string[]; rowCount: number; executionTime: number } = {
  rows: [{ id: 1, email: "a@b.c" }],
  fields: ["id", "email"],
  rowCount: 1,
  executionTime: 3,
};
let queryFails: Error | null = null;
const query = mock(async () => {
  if (queryFails) throw queryFails;
  return queryResult;
});
let lastPrepareOptions: unknown = null;
const getOrCreateProvider = mock(async () => ({
  prepareQuery: (sql: string, options: unknown) => {
    lastPrepareOptions = options;
    return { query: `${sql} /* prepared */`, limit: 1000, offset: 0, wasLimited: false };
  },
  query,
}));
mock.module("@/lib/db", () => ({ getOrCreateProvider }));
mock.module("@/lib/db/application-name", () => ({ applicationNameFor: (u: string) => `app:${u}` }));
const maskResult = mock(async (result: { rows: Record<string, unknown>[] }) => ({
  ...result,
  rows: result.rows.map((r) => ({ ...r, email: "***" })),
  masked: ["email"],
}));
mock.module("@/lib/masking/store", () => ({ maskResult }));
const notifyReviewers = mock(async () => true);
const notifyExecutionOutcome = mock(async () => true);
mock.module("@/lib/notify/slack", () => ({ notifyReviewers, notifyExecutionOutcome }));
// docs/CONTEXT.md §4.25: the callback module is proven in tests/unit/notify/callback.test.ts; here it is
// a validator with one allowed URL and a delivery that is counted.
const notifyCallback = mock(async () => true);
mock.module("@/lib/notify/callback", () => ({
  notifyCallback,
  readCallbackUrl: (value: unknown) =>
    value === "https://bot.example.test/hook" ? { url: value } : { error: "callback.url host is not allowed" },
}));
const audit = mock(() => ({}));
mock.module("@/lib/audit", () => ({ emitAuditEvent: audit, isStatementAuditEnabled: () => false }));
let frozenWindow: { id: string; reason: string; from: string; until: string } | null = null;
mock.module("@/lib/freezes/store", () => ({ activeFreeze: async () => frozenWindow }));
// docs/CONTEXT.md §4.19: the token behind an approved run is rebuilt with its named roles.
const withNamedRoles = mock(async (s: Record<string, unknown>) => ({ ...s, namedRoles: ["bots"] }));
mock.module("@/lib/roles/store", () => ({ withNamedRoles }));
let liveToken: ServiceIdentity | null = null;
mock.module("@/lib/service-tokens/store", () => ({
  findServiceTokenByActor: async (actor: string) =>
    liveToken && liveToken.session.username === actor ? liveToken : null,
}));

const { boundRows, getExecutionForToken, runExecution, settleDecision, submitExecution, RESULT_MAX_ROWS } =
  await import("@/lib/executions/store");
const { ApprovalError } = await import("@/lib/approvals/errors");

const bot = (
  over: Partial<ServiceIdentity["token"]> = {},
  session: Partial<ServiceIdentity["session"]> = {},
): ServiceIdentity => ({
  token: {
    id: "t1",
    name: "bot",
    role: "user",
    requireApproval: false,
    secretHash: "",
    prefix: "dbp_",
    createdAt: "x",
    createdBy: "root",
    ...over,
  },
  session: { role: "user", username: "svc:bot", ...session },
});
const ask = (input: Record<string, unknown>, identity = bot()) =>
  submitExecution({ datasourceId: "plain", statement: "SELECT 1", onBehalfOf: "U01", ...input }, identity);
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof ApprovalError ? e.statusCode : e instanceof SeedConnectionError ? e.statusCode : -1;
  }
};
const audited = () => audit.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);

describe("executions store", () => {
  beforeEach(() => {
    rows = new Map();
    enabled = true;
    queryFails = null;
    liveToken = null;
    denyAll = false;
    frozenWindow = null;
    for (const m of [
      provider.putApproval,
      query,
      getOrCreateProvider,
      maskResult,
      notifyReviewers,
      notifyExecutionOutcome,
      audit,
    ])
      m.mockClear();
  });

  test("the request must carry a datasource, a statement within bounds, a person, and a well-formed reply", async () => {
    expect(await status(ask({ datasourceId: "" }))).toBe(400);
    expect(await status(ask({ statement: "  " }))).toBe(400);
    expect(await status(ask({ statement: "x".repeat(32_001) }))).toBe(400);
    expect(await status(ask({ onBehalfOf: 42 }))).toBe(400);
    expect(await status(ask({ reply: "C1" }))).toBe(400);
    expect(await status(ask({ reply: { channel: "" } }))).toBe(400);
    expect(await status(ask({ reply: { channel: "C1", threadTs: 5 } }))).toBe(400);
    expect(await status(ask({ datasourceId: "ghost" }))).toBe(404);
    expect(provider.putApproval).not.toHaveBeenCalled();
  });

  test("a token's datasource allowlist and the datasource's write rule refuse with 403 before anything is stored", async () => {
    expect(await status(ask({ datasourceId: "plain" }, bot({ datasources: ["orders"] })))).toBe(403);
    expect(await status(ask({ datasourceId: "locked", statement: "DELETE FROM t WHERE id = 1" }))).toBe(403);
    expect(provider.putApproval).not.toHaveBeenCalled();
    // The allowlist admits what it names; an admin token may write on the locked one.
    const ran = await ask(
      { datasourceId: "locked", statement: "DELETE FROM t WHERE id = 1" },
      bot({ role: "admin" }, { role: "admin" }),
    );
    expect(ran.status).toBe("approved");
  });

  test("a read on a datasource without approval runs at once: approved by policy, masked, bounded, audited with subject", async () => {
    const record = await ask({ reply: { channel: "C1", threadTs: "1.2" } });
    expect(record).toMatchObject({
      kind: "execution",
      status: "approved",
      requester: "svc:bot",
      subject: "U01",
      datasourceName: "Plain",
      reply: { channel: "C1", threadTs: "1.2" },
    });
    expect(record.reviewer).toBeUndefined();
    expect(record.execution).toMatchObject({
      status: "done",
      rowCount: 1,
      fields: ["id", "email"],
      rows: [{ id: 1, email: "***" }],
    });
    expect(record.execution).not.toHaveProperty("truncated");
    expect(rows.get(record.id)?.execution?.status).toBe("done");
    expect(query).toHaveBeenCalledWith("SELECT 1 /* prepared */");
    expect((getOrCreateProvider.mock.calls[0] as unknown[])[1]).toMatchObject({ applicationName: "app:svc:bot" });
    expect((maskResult.mock.calls[0] as unknown[])[1]).toMatchObject({
      session: { username: "svc:bot" },
      reveal: false,
    });
    expect(audited()).toEqual([
      expect.objectContaining({
        type: "query_execution",
        target: "POST /api/v1/executions",
        user: "svc:bot",
        subject: "U01",
        connectionName: "Plain",
        result: "success",
      }),
    ]);
    expect(audited()[0]).not.toHaveProperty("approvalId");
    expect(notifyReviewers).not.toHaveBeenCalled();
    expect(notifyExecutionOutcome).toHaveBeenCalledTimes(1);
  });

  test("a write on a datasource that requires approval, or any request from a token that requires it, waits and is announced", async () => {
    const write = await ask({ datasourceId: "orders", statement: "DELETE FROM orders WHERE id = 1" });
    expect(write.status).toBe("pending");
    expect(write.execution).toBeUndefined();
    const read = await ask({}, bot({ requireApproval: true }));
    expect(read.status).toBe("pending");
    expect(query).not.toHaveBeenCalled();
    expect(notifyReviewers).toHaveBeenCalledTimes(2);
    // A read on the approval-gated datasource does not need the reviewer.
    const plainRead = await ask({ datasourceId: "orders", statement: "SELECT 1" });
    expect(plainRead.status).toBe("approved");
  });

  // docs/CONTEXT.md §4.15: a guardrail holds a bot's statement too, on any datasource, unless it opted out.
  test("a statement that trips a guardrail waits with the guardrail on the record; an opted-out datasource runs it", async () => {
    const held = await ask({ datasourceId: "plain", statement: "DELETE FROM orders" });
    expect(held.status).toBe("pending");
    expect(held.guardrail).toBe("delete_without_where");
    expect(query).not.toHaveBeenCalled();
    datasources.plain.guardrails = false;
    try {
      const ran = await ask({ datasourceId: "plain", statement: "DELETE FROM orders" });
      expect(ran.status).toBe("approved");
      expect(ran).not.toHaveProperty("guardrail");
    } finally {
      delete datasources.plain.guardrails;
    }
  });

  // docs/CONTEXT.md §4.16: the datasource's row cap holds the bot's statement too.
  test("a datasource's row cap reaches the provider; without one the options are empty", async () => {
    datasources.plain.limits = { maxRows: 3 };
    try {
      await ask({});
      expect(lastPrepareOptions).toEqual({ limit: 3, unlimited: false });
    } finally {
      delete datasources.plain.limits;
    }
    await ask({});
    expect(lastPrepareOptions).toEqual({});
  });

  // docs/CONTEXT.md §4.17: a write during a freeze is refused at once; one approved into a
  // window does not run and says why; a read is never frozen.
  test("a freeze window refuses a bot's write with 403, fails an approved one, and leaves a read alone", async () => {
    frozenWindow = { id: "w", reason: "Deploy", from: "x", until: "2026-09-14T02:00:00.000Z" };
    const refused = await ask({ datasourceId: "plain", statement: "DELETE FROM t WHERE id = 1" }).catch((e) => e);
    expect(refused).toBeInstanceOf(ApprovalError);
    expect(refused.statusCode).toBe(403);
    expect(refused.message).toContain("frozen until");
    expect((await ask({})).status).toBe("approved");
    frozenWindow = null;
    liveToken = bot();
    const queued = await ask({ datasourceId: "orders", statement: "DELETE FROM orders WHERE id = 1" });
    frozenWindow = { id: "w", reason: "Deploy", from: "x", until: "y" };
    const settled = await settleDecision({ ...queued, status: "approved", reviewer: "root" });
    expect(settled.execution).toMatchObject({ status: "failed", error: "freeze_window" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  // docs/CONTEXT.md §4.18: the ticket is read, bounded, kept on the record and written to the audit line.
  test("a ticket travels with the request into the audit line; a datasource that requires one refuses a write without it", async () => {
    const withTicket = await ask({ ticket: `  ${"x".repeat(130)}  ` });
    expect(withTicket.ticket).toBe("x".repeat(120));
    expect(audited().at(-1)).toMatchObject({ ticket: "x".repeat(120) });
    datasources.plain.requireTicket = true;
    try {
      const refused = await ask({ statement: "DELETE FROM t WHERE id = 1" }).catch((e) => e);
      expect(refused.statusCode).toBe(403);
      expect(refused.message).toContain("ticket or incident reference is required");
      expect((await ask({ statement: "DELETE FROM t WHERE id = 1", ticket: "INC-1" })).ticket).toBe("INC-1");
      expect((await ask({})).status).toBe("approved");
    } finally {
      delete datasources.plain.requireTicket;
    }
  });

  // docs/CONTEXT.md §4.25: the callback the bot named is kept on the record, validated at
  // submission, and told every outcome beside the Slack thread.
  test("a callback is validated, stored, and told the outcome of a run, a rejection and a failure", async () => {
    notifyCallback.mockClear();
    const refused = await ask({ callback: { url: "https://elsewhere.test/hook" } }).catch((e) => e);
    expect(refused.statusCode).toBe(400);
    expect(refused.message).toContain("not allowed");
    expect((await ask({ callback: "nope" }).catch((e) => e)).statusCode).toBe(400);
    const ran = await ask({ callback: { url: "https://bot.example.test/hook" } });
    expect(ran.callback).toEqual({ url: "https://bot.example.test/hook" });
    expect(notifyCallback).toHaveBeenCalledTimes(1);
    expect((notifyCallback.mock.calls[0] as unknown[])[0]).toMatchObject({ id: ran.id, execution: { status: "done" } });
    await settleDecision({ ...ran, status: "rejected", reviewer: "root" });
    expect(notifyCallback).toHaveBeenCalledTimes(2);
    expect((notifyCallback.mock.calls[1] as unknown[])[0]).toMatchObject({ status: "rejected" });
  });

  test("a failed run stores a closed reason, never the driver's words, and still answers the thread", async () => {
    queryFails = Object.assign(new Error('relation "secret_table" does not exist'), { name: "QueryError" });
    const record = await ask({});
    expect(record.execution?.status).toBe("failed");
    expect(JSON.stringify(record)).not.toContain("secret_table");
    expect(audited()[0]).toMatchObject({ result: "failure" });
    expect(notifyExecutionOutcome).toHaveBeenCalledTimes(1);
    // A datasource the token may no longer open at run time is a permission denial.
    liveToken = bot();
    const queued = await ask({ datasourceId: "orders", statement: "DELETE FROM orders" }, liveToken);
    const missing = { ...queued, status: "approved" as const, reviewer: "root" };
    rows.set(missing.id, missing);
    denyAll = true;
    const settled = await settleDecision(missing);
    expect(settled.execution).toMatchObject({ status: "failed", error: "permission_denied" });
  });

  // docs/CONTEXT.md §4.28: the record carries the datasource's reviewer count; the first of two
  // approvals runs nothing; a request nobody decided in time reads as expired for the bot.
  test("two reviewers: the record says so and a still-pending decision runs nothing; an old request reads as expired", async () => {
    const queued = await ask({ datasourceId: "two", statement: "DELETE FROM t WHERE id = 1" });
    expect(queued.status).toBe("pending");
    expect(queued.approvalsRequired).toBe(2);
    const half = { ...queued, approvals: [{ reviewer: "root", at: "x" }] };
    expect(await settleDecision(half)).toBe(half);
    expect(query).not.toHaveBeenCalled();
    rows.set(queued.id, { ...queued, requestedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    expect((await getExecutionForToken(queued.id, bot()))?.status).toBe("expired");
  });

  test("settleDecision leaves a window request alone, answers a rejection, fails a revoked token's request, and runs an approved one as its token", async () => {
    const window: ApprovalRequest = {
      id: "w1",
      datasourceId: "orders",
      datasourceName: "Orders",
      requester: "ana",
      statement: "DELETE",
      route: "POST /api/db/query",
      status: "approved",
      requestedAt: "x",
      windowUntil: "y",
    };
    expect(await settleDecision(window)).toBe(window);
    const queued = await ask({ datasourceId: "orders", statement: "DELETE FROM orders" });
    const rejected = { ...queued, status: "rejected" as const, reviewer: "root" };
    expect(await settleDecision(rejected)).toBe(rejected);
    expect(notifyExecutionOutcome).toHaveBeenCalledWith(rejected);
    expect(query).not.toHaveBeenCalled();

    const approved = { ...queued, status: "approved" as const, reviewer: "root" };
    const failed = await settleDecision(approved);
    expect(failed.execution).toMatchObject({ status: "failed", error: "token_revoked" });
    expect(rows.get(queued.id)?.execution?.error).toBe("token_revoked");

    liveToken = bot();
    const ran = await settleDecision(approved);
    expect(ran.execution?.status).toBe("done");
    expect(audited().at(-1)).toMatchObject({
      user: "svc:bot",
      subject: "U01",
      approvalId: queued.id,
      reviewer: "root",
    });
  });

  test("a token reads back only its own execution requests; a person's window request is invisible to it", async () => {
    const mine = await ask({});
    const other = await ask({}, bot({ name: "other" }, { username: "svc:other" }));
    expect((await getExecutionForToken(mine.id, bot()))?.id).toBe(mine.id);
    expect(await getExecutionForToken(other.id, bot())).toBeNull();
    expect(await getExecutionForToken("ghost", bot())).toBeNull();
    rows.set("w2", { ...mine, id: "w2", kind: undefined, requester: "svc:bot" });
    expect(await getExecutionForToken("w2", bot())).toBeNull();
  });

  test("without server storage a request, and a run, are a 503 that names the setting", async () => {
    enabled = false;
    expect(await status(ask({}))).toBe(503);
    const record: ApprovalRequest = {
      id: "x",
      kind: "execution",
      datasourceId: "plain",
      datasourceName: "Plain",
      requester: "svc:bot",
      statement: "SELECT 1",
      route: "POST /api/v1/executions",
      status: "approved",
      requestedAt: "now",
    };
    expect(await status(runExecution(record, bot()))).toBe(503);
  });

  test("boundRows keeps at most the row and byte limits and says when it cut", () => {
    const many = Array.from({ length: RESULT_MAX_ROWS + 5 }, (_, i) => ({ i }));
    const byCount = boundRows(many);
    expect(byCount.rows.length).toBe(RESULT_MAX_ROWS);
    expect(byCount.truncated).toBe(true);
    const fat = Array.from({ length: 10 }, () => ({ blob: "x".repeat(60 * 1024) }));
    const byBytes = boundRows(fat);
    expect(byBytes.rows.length).toBeLessThan(10);
    expect(byBytes.truncated).toBe(true);
    expect(boundRows([{ a: 1 }])).toEqual({ rows: [{ a: 1 }], truncated: false });
  });
});
