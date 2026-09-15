import { describe, test, expect, mock } from "bun:test";
import { spawn } from "node:child_process";

/**
 * The virtual session's child process (docs/CONTEXT.md §4.44), for real: the runner spawned
 * under this runtime, a session opened with its bootstrap, a statement answered, a
 * bootstrap that fails failing the open, the child dying mid-statement answering the
 * statement and every later one with the session gone, a runner that cannot start, and
 * where the runner is found.
 */
const errorLog = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { error: errorLog, warn: () => {}, info: () => {}, debug: () => {} } }));
const { RUNNER_ENV, VirtualSessionError, openVirtualClient, runnerPath } = await import(
  "@/lib/db/providers/virtual/client"
);

describe("virtual session client", () => {
  test("opens the runner, answers a statement with its columns and rows, and closes", async () => {
    const client = await openVirtualClient(["SET threads = 1"], { memory_limit: "64MB" });
    expect(client.pid).toBeGreaterThan(0);
    const result = await client.run("SELECT 40 + 2 AS answer, 'x' AS text");
    expect(result.columnNames).toEqual(["answer", "text"]);
    expect(result.rows).toEqual([{ answer: 42, text: "x" }]);
    expect(result.columnTypes[0]).toBe("INTEGER");
    const bound = await client.run("SELECT ? AS n", [7]);
    expect(bound.rows).toEqual([{ n: 7 }]);
    client.interrupt();
    client.close();
    await new Promise((r) => setTimeout(r, 300));
  });

  test("a bootstrap statement that fails fails the open, and the runner is gone", async () => {
    await expect(openVirtualClient(["SELECT * FROM no_such_table"], {})).rejects.toThrow(/no_such_table/);
  });

  test("a runner that dies mid-statement answers it and every later request with the session gone", async () => {
    const gone: string[] = [];
    const client = await openVirtualClient([], {}, { onGone: (why) => gone.push(why) });
    const slow = client.run("SELECT count(*) FROM range(200000000) a, range(100) b");
    await new Promise((r) => setTimeout(r, 200));
    process.kill(client.pid as number, "SIGKILL");
    await expect(slow).rejects.toBeInstanceOf(VirtualSessionError);
    await expect(slow).rejects.toThrow("ended with SIGKILL");
    await expect(client.run("SELECT 1")).rejects.toThrow("ended with SIGKILL");
    expect(gone).toEqual(["The virtual session ended with SIGKILL"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(errorLog).toHaveBeenCalledWith(
      "Virtual session runner died",
      expect.any(Error),
      expect.objectContaining({ route: "db/virtual" }),
    );
  });

  test("a runner that cannot start is the open failing, and the runner is found by the variable or the checkout", async () => {
    await expect(
      openVirtualClient(
        [],
        {},
        { spawnRunner: () => spawn("/nonexistent/runner", [], { stdio: ["pipe", "pipe", "pipe"] }) },
      ),
    ).rejects.toThrow("could not start");
    const saved = process.env[RUNNER_ENV];
    process.env[RUNNER_ENV] = "/somewhere/runner.mjs";
    expect(runnerPath()).toBe("/somewhere/runner.mjs");
    delete process.env[RUNNER_ENV];
    expect(runnerPath()).toContain("src/lib/db/providers/virtual/runner.mjs");
    const cwd = process.cwd();
    process.chdir("/tmp");
    expect(() => runnerPath()).toThrow(RUNNER_ENV);
    process.chdir(cwd);
    if (saved !== undefined) process.env[RUNNER_ENV] = saved;
  });

  // Two seams the real runner never exercises: a line on stdout that is not an answer (the
  // engine printing something) is skipped, and a child that never answers ends the open.
  test("a stdout line that is not JSON is ignored, and a child that never answers ends the open", async () => {
    const fake = () =>
      spawn(process.execPath, [
        "-e",
        `process.stdout.write("not json\\n"); require("readline").createInterface({ input: process.stdin }).on("line", (l) => { const r = JSON.parse(l); process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: { columnNames: [], columnTypes: [], rows: [], rowsChanged: 0 } }) + "\\n"); });`,
      ]);
    const client = await openVirtualClient([], {}, { spawnRunner: fake });
    expect((await client.run("SELECT 1")).rows).toEqual([]);
    client.close();
    await new Promise((r) => setTimeout(r, 200));
    // A child that never answers and then exits is the open failing with the session ended,
    // and a gone callback that throws is one error line, never an uncaught exception.
    const deaf = () => spawn("sleep", ["0.3"], { stdio: ["pipe", "pipe", "pipe"] });
    const throwing = () => {
      throw new Error("callback broke");
    };
    await expect(openVirtualClient([], {}, { spawnRunner: deaf, onGone: throwing })).rejects.toThrow(/ended/);
    expect(errorLog).toHaveBeenCalledWith(
      "Virtual session onGone failed",
      expect.any(Error),
      expect.objectContaining({ route: "db/virtual" }),
    );
  });
});
