import { isReadStatement, principalsOf } from "@/lib/access";
import { assertContainerDepth, ObjectRouteError } from "@/lib/api/object-route";
import { ApprovalError } from "@/lib/approvals/errors";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { submitExecution } from "@/lib/executions/store";
import { logger } from "@/lib/logger";
import { getManagedConnections } from "@/lib/seed";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { ServiceIdentity } from "@/lib/service-tokens/types";

/**
 * The MCP surface for troubleshooting agents (docs/CONTEXT.md §4.30): JSON-RPC 2.0 over one
 * POST, the Streamable HTTP transport without sessions or streams - every request is
 * answered whole, so nothing has to be held in memory between two calls and the endpoint
 * scales like any other route. Three tools, and only three: the datasources the token may
 * open, what one of them holds, and a statement that READS - a write is refused here
 * whatever the token's role, because the surface is for looking, not for changing. The read
 * goes through the same path a bot's does (§4.10): the token's datasource list, the access
 * rule, the guardrails, the limits, masking, a bounded result, and the audit line with the
 * token as actor. A token with `requireApproval` sees its read queued, like a bot would.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_NAME = "dbportal";
export const DESCRIBE_LIMIT = 200;

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export const TOOLS = [
  {
    name: "list_datasources",
    description:
      "The datasources this token may open, with id, name, engine and environment. Use the id with the other tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_schema",
    description:
      "What a datasource holds. Without `container`, its containers (schemas, databases, keyspaces). With one, the objects of `kind` (default `table`) in it, each with its columns, indexes and foreign keys.",
    inputSchema: {
      type: "object",
      properties: {
        datasourceId: { type: "string", description: "A datasource id from list_datasources." },
        container: { type: "array", items: { type: "string" }, description: 'The container path, e.g. ["public"].' },
        kind: { type: "string", description: "The object kind to describe; `table` when absent." },
      },
      required: ["datasourceId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_query",
    description:
      "Run a statement that READS on a datasource and return its rows (masked by the server's rules, at most 200 rows). A statement that writes is refused. A datasource that requires approval answers with a request id to poll.",
    inputSchema: {
      type: "object",
      properties: {
        datasourceId: { type: "string" },
        statement: { type: "string" },
        onBehalfOf: {
          type: "string",
          description: "The person the question is for, when the agent acts for one; the token's own name otherwise.",
        },
        ticket: { type: "string", description: "A ticket or incident reference to put on the audit line." },
      },
      required: ["datasourceId", "statement"],
      additionalProperties: false,
    },
  },
] as const;

function result(id: unknown, value: unknown): McpAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, result: value } };
}

function failure(id: unknown, code: number, message: string): McpAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function text(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The datasource the token may name; the token's own list first, the access rule second. */
async function open(datasourceId: unknown, identity: ServiceIdentity) {
  const id = typeof datasourceId === "string" ? datasourceId.trim() : "";
  if (!id) throw new ApprovalError("datasourceId is required", 400);
  const allowed = identity.token.datasources;
  if (allowed && allowed.length > 0 && !allowed.includes(id)) {
    throw new ApprovalError(`This token may not use datasource "${id}"`, 403);
  }
  return resolveConnection({ connectionId: `seed:${id}` }, identity.session);
}

async function listDatasources(identity: ServiceIdentity) {
  const allowed = identity.token.datasources;
  const all = await getManagedConnections(principalsOf(identity.session));
  return all
    .filter((c) => !allowed || allowed.length === 0 || allowed.includes(c.seedId))
    .map((c) => ({ id: c.seedId, name: c.name, engine: c.type, environment: c.environment ?? "other" }));
}

async function describeSchema(args: Record<string, unknown>, identity: ServiceIdentity) {
  const connection = await open(args.datasourceId, identity);
  const provider = await getOrCreateProvider(connection, {
    applicationName: applicationNameFor(identity.session.username),
    readOnly: true,
  });
  const container = args.container;
  if (container === undefined) {
    const containers = await provider.listContainers();
    return { datasource: connection.seedId, containers: containers.map((c) => ({ path: c.path, name: c.name })) };
  }
  if (!Array.isArray(container) || !container.every((s) => typeof s === "string")) {
    throw new ObjectRouteError('"container" must be an array of path segments', 400);
  }
  assertContainerDepth(provider, "container", container);
  const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "table";
  const batch = await provider.describeObjects(container, kind, DESCRIBE_LIMIT);
  return {
    datasource: connection.seedId,
    container,
    kind,
    objects: batch.details.map((d) => ({
      path: d.path,
      columns: d.columns,
      indexes: d.indexes,
      foreignKeys: d.foreignKeys,
    })),
    ...(batch.truncated ? { truncated: batch.truncated } : {}),
  };
}

async function runQuery(args: Record<string, unknown>, identity: ServiceIdentity) {
  const connection = await open(args.datasourceId, identity);
  const statement = typeof args.statement === "string" ? args.statement.trim() : "";
  if (!statement) throw new ApprovalError("statement is required", 400);
  if (!isReadStatement(statement, connection.type)) {
    throw new ApprovalError(`Only a statement that reads may run through the MCP surface on "${connection.name}"`, 403);
  }
  const record = await submitExecution(
    {
      datasourceId: connection.seedId,
      statement,
      onBehalfOf:
        typeof args.onBehalfOf === "string" && args.onBehalfOf.trim() ? args.onBehalfOf : identity.session.username,
      ticket: args.ticket,
    },
    identity,
  );
  if (record.status === "pending") {
    return {
      status: "pending",
      requestId: record.id,
      message: `The read waits for a reviewer on "${connection.name}"; poll GET /api/v1/executions/${record.id}.`,
    };
  }
  const outcome = record.execution;
  if (!outcome || outcome.status !== "done") {
    return { status: "failed", requestId: record.id, error: outcome?.error ?? "execution_failed" };
  }
  return {
    status: "done",
    rowCount: outcome.rowCount,
    fields: outcome.fields,
    rows: outcome.rows,
    ...(outcome.truncated ? { truncated: true } : {}),
    durationMs: outcome.durationMs,
  };
}

async function callTool(params: Record<string, unknown>, identity: ServiceIdentity): Promise<Record<string, unknown>> {
  const name = params.name;
  const args = asObject(params.arguments);
  try {
    switch (name) {
      case "list_datasources":
        return text(await listDatasources(identity));
      case "describe_schema":
        return text(await describeSchema(args, identity));
      case "run_query": {
        const outcome = await runQuery(args, identity);
        return text(outcome, outcome.status === "failed");
      }
      default:
        throw new ToolNotFound(String(name));
    }
  } catch (error) {
    if (error instanceof ToolNotFound) throw error;
    // The refusals the surface knows are told to the agent in their own words; anything else
    // is one line in the server log and a closed word to the agent.
    if (error instanceof ApprovalError || error instanceof SeedConnectionError || error instanceof ObjectRouteError) {
      return text(`${error.message}`, true);
    }
    logger.warn("MCP tool call failed", {
      route: "POST /api/mcp",
      tool: String(name),
      error: error instanceof Error ? error.name : "error",
    });
    return text("The tool call failed; an administrator sees the detail in the server log.", true);
  }
}

class ToolNotFound extends Error {
  constructor(name: string) {
    super(`Unknown tool "${name}"`);
    this.name = "ToolNotFound";
  }
}

/** One JSON-RPC message from a client that already proved its token. */
export async function handleMcpMessage(
  message: unknown,
  identity: ServiceIdentity,
  version: string,
): Promise<McpAnswer> {
  if (Array.isArray(message))
    return failure(null, INVALID_REQUEST, "Batches are not supported; send one message per request");
  const req = asObject(message) as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return failure(req.id, INVALID_REQUEST, "A JSON-RPC 2.0 message with a method is required");
  }
  const params = asObject(req.params);
  // A notification carries no id and gets no body.
  if (req.id === undefined || req.id === null) {
    if (!req.method.startsWith("notifications/")) return failure(null, INVALID_REQUEST, "A request needs an id");
    return { status: 202, body: null };
  }
  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version },
        instructions:
          "Start with list_datasources. describe_schema tells what a datasource holds. run_query runs a statement that reads and returns masked, bounded rows; writes are refused here.",
      });
    case "ping":
      return result(req.id, {});
    case "tools/list":
      return result(req.id, { tools: TOOLS });
    case "tools/call":
      try {
        return result(req.id, await callTool(params, identity));
      } catch (error) {
        if (error instanceof ToolNotFound) return failure(req.id, INVALID_PARAMS, error.message);
        return failure(req.id, INTERNAL_ERROR, "Internal error");
      }
    default:
      return failure(req.id, METHOD_NOT_FOUND, `Method "${req.method}" is not supported`);
  }
}

/** A body that is not JSON: the one error a client can get before its message is read. */
export function parseError(): McpAnswer {
  return failure(null, PARSE_ERROR, "The body is not JSON");
}
