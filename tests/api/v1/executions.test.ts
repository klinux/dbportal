import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The bot-facing execution routes (docs/CONTEXT.md §4.10) over a mocked guard and store:
 * the Bearer gate, the body handed to the store, 200 versus 202 by the record's status,
 * the token-scoped read, and how the store's refusals come back.
 */
let identity: { token: { id: string }; session: { role: string; username: string } } | null = {
  token: { id: "t1" },
  session: { role: "user", username: "svc:bot" },
};
mock.module("@/lib/api/service-auth", () => ({
  guardServiceRoute: async () =>
    identity
      ? { identity }
      : { response: Response.json({ error: "A valid service token is required" }, { status: 401 }) },
}));
const record: ApprovalRequest = {
  id: "exec-1",
  kind: "execution",
  datasourceId: "orders",
  datasourceName: "Orders",
  requester: "svc:bot",
  subject: "U01",
  statement: "SELECT 1",
  route: "POST /api/v1/executions",
  status: "pending",
  requestedAt: "2026-09-14T00:00:00.000Z",
};
const submit = mock(async () => record);
const getForToken = mock(async (id: string) => (id === "exec-1" ? record : null));
mock.module("@/lib/executions/store", () => ({
  submitExecution: (...args: unknown[]) => submit(...(args as [])),
  getExecutionForToken: (id: string) => getForToken(id),
}));

const { POST } = await import("@/app/api/v1/executions/route");
const { GET } = await import("@/app/api/v1/executions/[id]/route");
const { ApprovalError } = await import("@/lib/approvals/errors");

const url = "http://localhost/api/v1/executions";
const post = (body: unknown) =>
  POST(
    new Request(url, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/v1/executions", () => {
  beforeEach(() => {
    identity = { token: { id: "t1" }, session: { role: "user", username: "svc:bot" } };
    submit.mockClear();
    submit.mockImplementation(async () => record);
  });

  test("both routes need a valid service token", async () => {
    identity = null;
    expect((await post({ datasourceId: "orders", statement: "SELECT 1", onBehalfOf: "U01" })).status).toBe(401);
    expect((await GET(new Request(url), params("exec-1"))).status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });

  test("POST hands the four fields and the identity to the store; 202 while pending, 200 once it ran", async () => {
    const res = await post({
      datasourceId: "orders",
      statement: "SELECT 1",
      onBehalfOf: "U01",
      reply: { channel: "C1" },
      extra: 1,
    });
    expect(res.status).toBe(202);
    expect((await res.json()).execution.id).toBe("exec-1");
    const [input, who] = submit.mock.calls[0] as unknown[];
    expect(input).toEqual({
      datasourceId: "orders",
      statement: "SELECT 1",
      onBehalfOf: "U01",
      reply: { channel: "C1" },
    });
    expect((who as { session: { username: string } }).session.username).toBe("svc:bot");
    submit.mockImplementation(async () => ({ ...record, status: "approved", execution: { status: "done" } as never }));
    const ran = await post({ datasourceId: "orders", statement: "SELECT 1", onBehalfOf: "U01" });
    expect(ran.status).toBe(200);
    expect((await ran.json()).execution.execution.status).toBe("done");
  });

  test("a body that is not an object is 400; the store's refusals keep their status; anything else is 500", async () => {
    expect((await post("[]")).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    submit.mockImplementation(async () => {
      throw new ApprovalError('This token may not use datasource "orders"', 403);
    });
    const refused = await post({ datasourceId: "orders", statement: "SELECT 1", onBehalfOf: "U01" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("may not use");
    submit.mockImplementation(async () => {
      throw new Error("boom");
    });
    expect((await post({ datasourceId: "orders", statement: "SELECT 1", onBehalfOf: "U01" })).status).toBe(500);
  });

  test("GET answers the token's own record and 404 for anything else", async () => {
    const res = await GET(new Request(url), params("exec-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).execution.subject).toBe("U01");
    expect((await GET(new Request(url), params("other"))).status).toBe(404);
    getForToken.mockImplementationOnce(async () => {
      throw new ApprovalError("Executions need server storage", 503);
    });
    expect((await GET(new Request(url), params("exec-1"))).status).toBe(503);
  });
});
