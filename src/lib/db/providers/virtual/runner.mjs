/**
 * The process a virtual datasource's DuckDB session lives in (docs/CONTEXT.md §4.44).
 *
 * The session loads the postgres and mysql extensions and attaches remote engines, all of
 * it native code inside libduckdb. A fault there is a segfault, and a segfault inside the
 * studio takes every session and every request with it - seen once, on the first probe of
 * a virtual datasource beside the other embedded engines. So the session runs here, in a
 * child the provider spawns, and a fault ends this process alone: the statement fails, the
 * provider reports the session gone, the studio answers everybody else.
 *
 * Plain JavaScript on purpose: it is spawned by path at runtime, under bun in development
 * and node in the image, outside the Next.js bundle. It speaks JSON lines over stdio -
 * credentials arrive on stdin, never on argv or in the environment - and exits when stdin
 * closes. One request at a time is answered in order; the parent keeps the queue.
 *
 *   -> {"id":1,"op":"open","config":{...},"bootstrap":["LOAD postgres","ATTACH ..."]}
 *   <- {"id":1,"ok":true}
 *   -> {"id":2,"op":"run","sql":"SELECT 1","params":[]}
 *   <- {"id":2,"ok":true,"result":{"columnNames":[...],"columnTypes":[...],"rows":[...],"rowsChanged":0}}
 *   -> {"id":3,"op":"interrupt"}   (answered at once; the running statement then fails)
 *   -> {"id":4,"op":"close"}
 */
import { createInterface } from "node:readline";
import { DuckDBInstance } from "@duckdb/node-api";

let instance = null;
let connection = null;

function answer(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function failure(id, error) {
  answer({ id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
}

async function open(request) {
  instance = await DuckDBInstance.create(":memory:", request.config ?? {});
  connection = await instance.connect();
  for (const sql of request.bootstrap ?? []) await connection.run(sql);
}

async function run(request) {
  if (!connection) throw new Error("The session is not open");
  const reader =
    request.params === undefined ? await connection.runAndReadAll(request.sql) : await connection.runAndReadAll(request.sql, request.params);
  return {
    columnNames: reader.columnNames(),
    columnTypes: reader.columnTypes().map(String),
    rows: reader.getRowObjectsJson(),
    rowsChanged: reader.rowsChanged,
  };
}

function close() {
  try {
    connection?.disconnectSync();
    instance?.closeSync();
  } finally {
    connection = null;
    instance = null;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let chain = Promise.resolve();
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.op === "interrupt") {
    // Out of band: the statement in flight is what it interrupts, so it must not queue behind it.
    try {
      connection?.interrupt();
      answer({ id: request.id, ok: true });
    } catch (error) {
      failure(request.id, error);
    }
    return;
  }
  chain = chain.then(async () => {
    try {
      if (request.op === "open") {
        await open(request);
        answer({ id: request.id, ok: true });
      } else if (request.op === "run") {
        answer({ id: request.id, ok: true, result: await run(request) });
      } else if (request.op === "close") {
        close();
        answer({ id: request.id, ok: true });
        process.exit(0);
      } else {
        throw new Error(`Unknown op: ${request.op}`);
      }
    } catch (error) {
      failure(request.id, error);
    }
  });
});
lines.on("close", () => {
  close();
  process.exit(0);
});
