import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ServiceIdentity } from "@/lib/service-tokens/types";

/**
 * The MCP surface (docs/CONTEXT.md §4.30) over mocked stores and a mocked provider: the
 * JSON-RPC envelope (initialize, ping, tools/list, notifications, the errors), and the
 * three tools - the token's datasources, a schema read, a statement that reads through
 * the bot's own path - with every refusal told to the agent in words and nothing else.
 */
mock.module("@/lib/logger", () => ({ logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} } }));
const orders = { id: "seed:orders", seedId: "orders", name: "Orders", type: "postgres", environment: "staging" };
const hr = { id: "seed:hr", seedId: "hr", name: "HR", type: "postgres" };
mock.module("@/lib/seed", () => ({ getManagedConnections: async () => [orders, hr] }));
class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}
mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: async (body: { connectionId?: string }) => {
    if (body.connectionId === "seed:orders") return orders;
    if (body.connectionId === "seed:hr") return hr;
    throw new SeedConnectionError(`Seed connection "${body.connectionId}" not found`, 404);
  },
}));
const provider = {
  getCapabilities: () => ({ containerLevels: [{ kind: "schema" }] }),
  listContainers: mock(async () => [{ path: ["public"], name: "public", level: 0 }]),
  describeObjects: mock(async (_c: readonly string[], kind: string, _limit?: number) =>
    kind === "boom"
      ? Promise.reject(new Error("catalog"))
      : {
          details: [
            { path: ["public", "orders"], columns: [{ name: "id", type: "int4" }], indexes: [], foreignKeys: [] },
          ],
          truncated: { limit: 200, reason: "cap" },
        },
  ),
};
mock.module("@/lib/db", () => ({ getOrCreateProvider: async () => provider }));
const { ApprovalError } = await import("@/lib/approvals/errors");
let record: Record<string, unknown> = {
  id: "exec-1",
  status: "approved",
  execution: { status: "done", rowCount: 1, fields: ["n"], rows: [{ n: 1 }], durationMs: 3 },
};
const submit = mock(async (_input: unknown, _identity: unknown) => record);
// The worker's answer (§4.40): what waitForExecution hands back, or null when it ran out of time.
let landed: Record<string, unknown> | null | "same" = "same";
const waited = mock(async (_id: string, _ms: number) => (landed === "same" ? record : landed));
mock.module("@/lib/executions/store", () => ({ submitExecution: submit, waitForExecution: waited }));

const { DESCRIBE_LIMIT, MCP_PROTOCOL_VERSION, RUN_WAIT_MS, TOOLS, handleMcpMessage, parseError } = await import(
  "@/lib/mcp/server"
);

const identity = (over: Partial<ServiceIdentity["token"]> = {}): ServiceIdentity =>
  ({
    token: { id: "t1", name: "agent", role: "user", requireApproval: false, ...over },
    session: { role: "user", username: "svc:agent" },
  }) as ServiceIdentity;
const call = (name: string, args: Record<string, unknown> = {}, who = identity()) =>
  handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, who, "0.1.0");
const resultOf = (answer: { body: Record<string, unknown> | null }) => (answer.body as Record<string, unknown>).result;
const textOf = (answer: { body: Record<string, unknown> | null }) =>
  (resultOf(answer) as { content: { text: string }[] }).content[0].text as string;
const parsed = (answer: { body: Record<string, unknown> | null }) => JSON.parse(textOf(answer));
const isError = (answer: { body: Record<string, unknown> | null }) =>
  (resultOf(answer) as { isError?: boolean }).isError === true;

describe("mcp server", () => {
  beforeEach(() => {
    submit.mockClear();
    record = {
      id: "exec-1",
      status: "approved",
      execution: { status: "done", rowCount: 1, fields: ["n"], rows: [{ n: 1 }], durationMs: 3 },
    };
  });

  test("the envelope: initialize, ping, tools/list, a notification, and the JSON-RPC errors", async () => {
    const init = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      identity(),
      "0.1.0",
    );
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "dbportal", version: "0.1.0" },
      },
    });
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: "a", method: "ping" }, identity(), "0.1.0")).body).toEqual({
      jsonrpc: "2.0",
      id: "a",
      result: {},
    });
    const list = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, identity(), "0.1.0");
    expect((resultOf(list) as { tools: unknown[] }).tools).toEqual([...TOOLS]);
    expect(TOOLS.map((t) => t.name)).toEqual(["list_datasources", "describe_schema", "run_query"]);
    expect(
      await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, identity(), "0.1.0"),
    ).toEqual({ status: 202, body: null });
    expect((await handleMcpMessage({ jsonrpc: "2.0", method: "tools/list" }, identity(), "0.1.0")).body).toMatchObject({
      error: { code: -32600 },
    });
    expect(
      (await handleMcpMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }], identity(), "0.1.0")).body,
    ).toMatchObject({ id: null, error: { code: -32600 } });
    expect((await handleMcpMessage({ id: 3, method: "ping" }, identity(), "0.1.0")).body).toMatchObject({
      id: 3,
      error: { code: -32600 },
    });
    expect((await handleMcpMessage("nope", identity(), "0.1.0")).body).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(
      (await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" }, identity(), "0.1.0")).body,
    ).toMatchObject({ error: { code: -32601 } });
    expect((await call("teleport")).body).toMatchObject({
      id: 7,
      error: { code: -32602, message: 'Unknown tool "teleport"' },
    });
    expect(parseError()).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "The body is not JSON" } },
    });
  });

  test("list_datasources: the token's list, narrowed to the ids it may name", async () => {
    expect(parsed(await call("list_datasources"))).toEqual([
      { id: "orders", name: "Orders", engine: "postgres", environment: "staging" },
      { id: "hr", name: "HR", engine: "postgres", environment: "other" },
    ]);
    expect(parsed(await call("list_datasources", {}, identity({ datasources: ["hr"] })))).toEqual([
      { id: "hr", name: "HR", engine: "postgres", environment: "other" },
    ]);
  });

  test("describe_schema: the containers, then the objects of a kind with their columns; the refusals in words", async () => {
    expect(parsed(await call("describe_schema", { datasourceId: "orders" }))).toEqual({
      datasource: "orders",
      containers: [{ path: ["public"], name: "public" }],
    });
    const objects = await call("describe_schema", { datasourceId: "orders", container: ["public"] });
    expect(parsed(objects)).toEqual({
      datasource: "orders",
      container: ["public"],
      kind: "table",
      objects: [{ path: ["public", "orders"], columns: [{ name: "id", type: "int4" }], indexes: [], foreignKeys: [] }],
      truncated: { limit: 200, reason: "cap" },
    });
    expect(provider.describeObjects.mock.calls[0]).toEqual([["public"], "table", DESCRIBE_LIMIT]);
    await call("describe_schema", { datasourceId: "orders", container: ["public"], kind: " view " });
    expect(provider.describeObjects.mock.calls[1][1]).toBe("view");
    const missing = await call("describe_schema", {});
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toBe("datasourceId is required");
    expect(textOf(await call("describe_schema", { datasourceId: "ghost" }))).toContain("not found");
    expect(
      textOf(await call("describe_schema", { datasourceId: "orders" }, identity({ datasources: ["hr"] }))),
    ).toContain("may not use");
    expect(textOf(await call("describe_schema", { datasourceId: "orders", container: "public" }))).toContain(
      "array of path segments",
    );
    expect(textOf(await call("describe_schema", { datasourceId: "orders", container: ["a", "b"] }))).toContain(
      "container depth",
    );
    // The engine's own failure is one closed sentence, never its message.
    const failed = await call("describe_schema", { datasourceId: "orders", container: ["public"], kind: "boom" });
    expect(isError(failed)).toBe(true);
    expect(textOf(failed)).not.toContain("catalog");
  });

  test("run_query: a read through the bot's path with the token as the person unless one is named; a write refused; pending and failed told", async () => {
    const done = await call("run_query", { datasourceId: "orders", statement: " SELECT 1 AS n " });
    expect(isError(done)).toBe(false);
    expect(parsed(done)).toEqual({ status: "done", rowCount: 1, fields: ["n"], rows: [{ n: 1 }], durationMs: 3 });
    expect(submit.mock.calls[0][0]).toEqual({
      datasourceId: "orders",
      statement: "SELECT 1 AS n",
      onBehalfOf: "svc:agent",
      ticket: undefined,
    });
    await call("run_query", { datasourceId: "orders", statement: "SELECT 1", onBehalfOf: "ana", ticket: "INC-1" });
    expect(submit.mock.calls[1][0]).toMatchObject({ onBehalfOf: "ana", ticket: "INC-1" });
    const write = await call("run_query", { datasourceId: "orders", statement: "DELETE FROM orders" });
    expect(isError(write)).toBe(true);
    expect(textOf(write)).toContain("Only a statement that reads");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(textOf(await call("run_query", { datasourceId: "orders", statement: "" }))).toBe("statement is required");
    record = { id: "exec-2", status: "pending" };
    expect(parsed(await call("run_query", { datasourceId: "orders", statement: "SELECT 1" }))).toMatchObject({
      status: "pending",
      requestId: "exec-2",
    });
    // Approved by policy, but the worker did not answer within the wait: the id to poll.
    record = { id: "exec-q", status: "approved", jobId: "job-1" };
    landed = null;
    expect(parsed(await call("run_query", { datasourceId: "orders", statement: "SELECT 1" }))).toMatchObject({
      status: "queued",
      requestId: "exec-q",
    });
    expect(waited).toHaveBeenLastCalledWith("exec-q", RUN_WAIT_MS);
    landed = "same";
    record = { id: "exec-3", status: "approved", execution: { status: "failed", error: "execution_failed" } };
    const failed = await call("run_query", { datasourceId: "orders", statement: "SELECT 1" });
    expect(isError(failed)).toBe(true);
    expect(parsed(failed)).toEqual({ status: "failed", requestId: "exec-3", error: "execution_failed" });
    // Approved but with no outcome yet, even after the wait: queued, with the id to poll.
    record = { id: "exec-4", status: "approved" };
    expect(parsed(await call("run_query", { datasourceId: "orders", statement: "SELECT 1" }))).toMatchObject({
      status: "queued",
      requestId: "exec-4",
    });
    submit.mockImplementationOnce(async () => {
      throw new ApprovalError("This token may not use datasource", 403);
    });
    expect(textOf(await call("run_query", { datasourceId: "orders", statement: "SELECT 1" }))).toContain("may not use");
    submit.mockImplementationOnce(async () => {
      throw new Error("store down");
    });
    const crashed = await call("run_query", { datasourceId: "orders", statement: "SELECT 1" });
    expect(isError(crashed)).toBe(true);
    expect(textOf(crashed)).toContain("server log");
  });
});
