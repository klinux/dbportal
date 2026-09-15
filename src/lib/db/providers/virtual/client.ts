import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DuckDBClient, DuckDBStatementResult } from "../sql/duckdb/client";
import { logger } from "@/lib/logger";

/**
 * A DuckDB client whose session lives in a child process (docs/CONTEXT.md §4.44), so a
 * fault in the engine or an extension ends that process and not the server. It has the
 * shape the DuckDB provider already speaks - run, interrupt, close - which is what lets the
 * virtual provider inherit every read of that provider unchanged. The runner is
 * `runner.mjs` beside this file, found by DBPORTAL_VIRTUAL_RUNNER or by its path in the
 * checkout; the image copies it next to node_modules and sets the variable.
 */
export const RUNNER_ENV = "DBPORTAL_VIRTUAL_RUNNER";
const RUNNER_CANDIDATES = ["src/lib/db/providers/virtual/runner.mjs", "lib/virtual-runner.mjs"];

export class VirtualSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualSessionError";
  }
}

export function runnerPath(): string {
  const named = process.env[RUNNER_ENV]?.trim();
  if (named) return named;
  for (const candidate of RUNNER_CANDIDATES) {
    const full = path.join(process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  throw new VirtualSessionError(`The virtual session runner was not found; set ${RUNNER_ENV}`);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Answer {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface VirtualClientOptions {
  /** Told once when the child is gone, so the provider drops the client and the next open starts a new one. */
  onGone?: (why: string) => void;
  /** Tests only: how the runner is started. */
  spawnRunner?: () => ChildProcess;
}

/** Open the session in a child: the instance configuration and the bootstrap statements (loads, attaches, the lock). */
export async function openVirtualClient(
  bootstrap: readonly string[],
  config: Record<string, string>,
  options: VirtualClientOptions = {},
): Promise<DuckDBClient & { readonly pid: number | undefined }> {
  const spawnRunner =
    options.spawnRunner ??
    (() => spawn(process.execPath, [runnerPath()], { stdio: ["pipe", "pipe", "pipe"], env: process.env }));
  const child = spawnRunner();
  const pending = new Map<number, Pending>();
  let next = 1;
  let gone: Error | null = null;
  let stderr = "";

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const lines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }) : null;
  lines?.on("line", (line) => {
    let answer: Answer;
    try {
      answer = JSON.parse(line) as Answer;
    } catch {
      return;
    }
    const waiting = pending.get(answer.id);
    if (!waiting) return;
    pending.delete(answer.id);
    if (answer.ok) waiting.resolve(answer.result);
    else waiting.reject(new Error(answer.error?.message ?? "The virtual session failed"));
  });
  const ended = (why: string) => {
    if (gone) return;
    gone = new VirtualSessionError(why);
    for (const waiting of pending.values()) waiting.reject(gone);
    pending.clear();
    options.onGone?.(why);
  };
  child.on("exit", (code, signal) => {
    const why = signal ? `The virtual session ended with ${signal}` : `The virtual session ended (exit ${code ?? "?"})`;
    if (signal || (code !== null && code !== 0)) {
      logger.error("Virtual session runner died", new Error(why), { route: "db/virtual", stderr: stderr.slice(-500) });
    }
    ended(why);
  });
  child.on("error", (error) => ended(`The virtual session could not start: ${error.message}`));

  const ask = (message: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (gone) return reject(gone);
      const id = next++;
      pending.set(id, { resolve, reject });
      // A pipe the child no longer reads surfaces as the child's exit, which `ended` answers.
      child.stdin?.write(`${JSON.stringify({ id, ...message })}\n`);
    });

  try {
    await ask({ op: "open", config, bootstrap });
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    path: ":memory:",
    readOnly: false,
    pid: child.pid,
    async run(sql: string, params?: unknown[]): Promise<DuckDBStatementResult> {
      return (await ask({ op: "run", sql, params })) as DuckDBStatementResult;
    },
    interrupt(): void {
      void ask({ op: "interrupt" }).catch(() => {});
    },
    close(): void {
      void ask({ op: "close" }).catch(() => {});
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill();
      }, 1_000).unref?.();
    },
  };
}
