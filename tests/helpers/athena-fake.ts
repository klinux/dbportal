/**
 * A scripted stand-in for the Athena SDK client, shared by the transport's unit test
 * and the provider's integration test.
 *
 * `send` answers each command class from a script and records every call, so a test
 * can assert what was sent as well as what came back; nothing here reaches a network.
 * The payload shapes are the SDK's own model types, so a field the model does not
 * have does not compile.
 */
import { expect } from "bun:test";
import {
  BatchGetQueryExecutionCommand,
  type BatchGetQueryExecutionCommandOutput,
  type ColumnInfo,
  GetQueryExecutionCommand,
  type GetQueryExecutionCommandOutput,
  GetQueryResultsCommand,
  type GetQueryResultsCommandOutput,
  GetTableMetadataCommand,
  type GetTableMetadataCommandOutput,
  GetWorkGroupCommand,
  type GetWorkGroupCommandOutput,
  ListDatabasesCommand,
  type ListDatabasesCommandOutput,
  ListQueryExecutionsCommand,
  type ListQueryExecutionsCommandOutput,
  ListTableMetadataCommand,
  type ListTableMetadataCommandOutput,
  type QueryExecution,
  type Row,
  StartQueryExecutionCommand,
  type StartQueryExecutionCommandOutput,
  StopQueryExecutionCommand,
  type StopQueryExecutionCommandOutput,
} from "@aws-sdk/client-athena";
import { AthenaSdkTransport, type AthenaClientLike } from "@/lib/db/providers/sql/athena/sdk-transport";
import type { AthenaSettings } from "@/lib/db/providers/sql/athena/settings";
import { AthenaTransportError } from "@/lib/db/providers/sql/athena/transport";

export const SETTINGS: AthenaSettings = {
  region: "us-east-1",
  catalog: "AwsDataCatalog",
  database: "analytics",
  workgroup: "primary",
  outputLocation: "s3://lake-results/athena/",
  credentials: undefined,
};

export const ID = "11111111-2222-4333-8444-555555555555";
export const METADATA = { httpStatusCode: 200 };

export type Command =
  | StartQueryExecutionCommand
  | GetQueryExecutionCommand
  | GetQueryResultsCommand
  | StopQueryExecutionCommand
  | ListDatabasesCommand
  | ListTableMetadataCommand
  | GetTableMetadataCommand
  | GetWorkGroupCommand
  | ListQueryExecutionsCommand
  | BatchGetQueryExecutionCommand;

export interface Sent {
  command: Command;
  options: { abortSignal?: AbortSignal } | undefined;
}

/**
 * What the fake answers, per command class. A function is called with the command
 * and every earlier call of that class, so a script can answer a poll differently
 * the third time; an Error is thrown; undefined answers the emptiest valid output.
 */
export interface Script {
  start?: StartQueryExecutionCommandOutput | Error | ((seen: number) => StartQueryExecutionCommandOutput | Error);
  poll?: (seen: number) => GetQueryExecutionCommandOutput | Error;
  results?: (command: GetQueryResultsCommand, seen: number) => GetQueryResultsCommandOutput | Error;
  stop?: StopQueryExecutionCommandOutput | Error;
  databases?: (command: ListDatabasesCommand, seen: number) => ListDatabasesCommandOutput | Error;
  tables?: (command: ListTableMetadataCommand, seen: number) => ListTableMetadataCommandOutput | Error;
  table?: GetTableMetadataCommandOutput | Error;
  workgroup?: GetWorkGroupCommandOutput | Error;
  executions?: (command: ListQueryExecutionsCommand, seen: number) => ListQueryExecutionsCommandOutput | Error;
  batch?: (command: BatchGetQueryExecutionCommand) => BatchGetQueryExecutionCommandOutput | Error;
}

export class FakeClient {
  readonly sent: Sent[] = [];
  destroyed = false;

  constructor(private readonly script: Script) {}

  send(command: Command, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.sent.push({ command, options });
    // What the SDK does with an already-aborted signal: the request never leaves.
    if (options?.abortSignal?.aborted) return Promise.reject(serviceError("AbortError", "Request aborted"));
    const seen = this.sent.filter((call) => call.command.constructor === command.constructor).length;
    let answer: unknown;
    if (command instanceof StartQueryExecutionCommand) {
      const start = this.script.start;
      answer = typeof start === "function" ? start(seen) : (start ?? { QueryExecutionId: ID, $metadata: METADATA });
    } else if (command instanceof GetQueryExecutionCommand) {
      answer = this.script.poll?.(seen) ?? succeeded();
    } else if (command instanceof GetQueryResultsCommand) {
      answer = this.script.results?.(command, seen) ?? page([], []);
    } else if (command instanceof StopQueryExecutionCommand) {
      answer = this.script.stop ?? { $metadata: METADATA };
    } else if (command instanceof ListDatabasesCommand) {
      answer = this.script.databases?.(command, seen) ?? { DatabaseList: [], $metadata: METADATA };
    } else if (command instanceof ListTableMetadataCommand) {
      answer = this.script.tables?.(command, seen) ?? { TableMetadataList: [], $metadata: METADATA };
    } else if (command instanceof GetTableMetadataCommand) {
      answer = this.script.table ?? { $metadata: METADATA };
    } else if (command instanceof GetWorkGroupCommand) {
      answer = this.script.workgroup ?? { $metadata: METADATA };
    } else if (command instanceof ListQueryExecutionsCommand) {
      answer = this.script.executions?.(command, seen) ?? { QueryExecutionIds: [], $metadata: METADATA };
    } else {
      answer = this.script.batch?.(command) ?? { QueryExecutions: [], $metadata: METADATA };
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** The commands of one class, in order. */
  of<T extends Command>(kind: new (...args: never[]) => T): T[] {
    return this.sent.map((call) => call.command).filter((command): command is T => command instanceof kind);
  }
}

/** A transport over a scripted client, with no wait between polls. */
export function makeTransport(
  script: Script = {},
  settings: AthenaSettings = SETTINGS,
): { transport: AthenaSdkTransport; client: FakeClient } {
  const client = new FakeClient(script);
  const transport = new AthenaSdkTransport(settings, {
    client: client as unknown as AthenaClientLike,
    delay: () => Promise.resolve(),
  });
  return { transport, client };
}

export function execution(overrides: Partial<QueryExecution> = {}): QueryExecution {
  return {
    QueryExecutionId: ID,
    StatementType: "DML",
    Status: { State: "SUCCEEDED" },
    Statistics: {
      EngineExecutionTimeInMillis: 1500,
      QueryQueueTimeInMillis: 100,
      TotalExecutionTimeInMillis: 1800,
      DataScannedInBytes: 4096,
    },
    ResultConfiguration: { OutputLocation: `s3://lake-results/athena/${ID}.csv` },
    ...overrides,
  };
}

export function succeeded(overrides: Partial<QueryExecution> = {}): GetQueryExecutionCommandOutput {
  return { QueryExecution: execution(overrides), $metadata: METADATA };
}

export function inFlight(state: "QUEUED" | "RUNNING"): GetQueryExecutionCommandOutput {
  return { QueryExecution: execution({ Status: { State: state } }), $metadata: METADATA };
}

export function column(name: string, type: string): ColumnInfo {
  return { Name: name, Type: type };
}

export function row(...cells: (string | null)[]): Row {
  return { Data: cells.map((cell) => (cell === null ? {} : { VarCharValue: cell })) };
}

export function page(
  columns: ColumnInfo[],
  rows: Row[],
  extra: Partial<GetQueryResultsCommandOutput> = {},
): GetQueryResultsCommandOutput {
  return { ResultSet: { ResultSetMetadata: { ColumnInfo: columns }, Rows: rows }, $metadata: METADATA, ...extra };
}

/** A SELECT's first page, header row included, as the service sends it. */
export function selectPage(columns: ColumnInfo[], rows: Row[], extra: Partial<GetQueryResultsCommandOutput> = {}) {
  return page(columns, [row(...columns.map((c) => c.Name ?? "")), ...rows], extra);
}

export function serviceError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $fault: "client", $metadata: METADATA });
  return error;
}

export async function captureError(run: () => Promise<unknown>): Promise<AthenaTransportError> {
  try {
    await run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(AthenaTransportError);
    return caught as AthenaTransportError;
  }
  throw new Error("the transport resolved where it should have thrown");
}
