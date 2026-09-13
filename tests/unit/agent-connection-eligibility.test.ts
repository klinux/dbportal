/**
 * Which connections a run may be STARTED on.
 *
 * A run persists a connection id and no credential, so the process that resumes it
 * re-resolves that id server-side. Every datasource is declared server-side and opened by
 * its seed id (docs/CONTEXT.md §4.1), so the rule is one line: a seed reference resolves,
 * anything else is a stale row the server cannot rebuild. The last test here is the
 * anti-drift pin: it takes the real seed writers' output, puts it through the JSON round
 * trip the browser makes, and asserts the rule still accepts it.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import {
  buildConnectionPayload,
  resolveAgentRunConnectionId,
  type ManagedConnectionPayload,
} from "@/hooks/use-connection-payload";

/** A seed descriptor as `GET /api/connections/managed` serializes it. */
function descriptor(overrides: Partial<ManagedConnectionPayload> = {}): ManagedConnectionPayload {
  return {
    id: "seed:sales",
    seedId: "sales",
    name: "Sales",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "sales",
    user: "reader",
    password: "s3cret",
    managed: true,
    createdAt: "1970-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The row the browser holds for a served descriptor, after the JSON round trip. */
function browserCopy(from: ManagedConnectionPayload, edits: Partial<DatabaseConnection> = {}): DatabaseConnection {
  const serialized = JSON.parse(JSON.stringify(from)) as ManagedConnectionPayload;
  return { ...serialized, createdAt: new Date(serialized.createdAt), ...edits };
}

/** The id a run may be started on, dropping the reason the tests below do not read. */
function startableId(conn: DatabaseConnection): string | null {
  return resolveAgentRunConnectionId(conn).id;
}

describe("which connection a run may be started on", () => {
  test("a served datasource is startable by its seed reference", () => {
    expect(resolveAgentRunConnectionId(browserCopy(descriptor()))).toEqual({ id: "seed:sales" });
    // Whatever the row says about itself locally: the server rebuilds it from its declaration.
    expect(startableId(browserCopy(descriptor(), { name: "Renamed", database: "elsewhere" }))).toBe("seed:sales");
  });

  test("a row with no seed origin is not startable, and says so", () => {
    const stale: DatabaseConnection = { id: "local-1", name: "Local", type: "postgres", createdAt: new Date(0) };
    expect(resolveAgentRunConnectionId(stale)).toEqual({ id: null, reason: "browser-only" });
  });
});

describe("the connections a default deployment ships", () => {
  let builders: { seedId: string; build: () => { seedId: string } }[] = [];

  beforeAll(async () => {
    process.env.DBPORTAL_EMBEDDED_SAMPLE_PATH = "/tmp/libredb-eligibility-sample.libredb";
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = "/tmp/libredb-eligibility-sample.db";
    const [libredb, sqlite] = await Promise.all([
      import("@/lib/seed/libredb-sample"),
      import("@/lib/seed/sqlite-sample"),
    ]);
    builders = [
      { seedId: libredb.SAMPLE_SEED_ID, build: libredb.buildSampleConnection },
      { seedId: sqlite.SQLITE_SAMPLE_SEED_ID, build: sqlite.buildSqliteSampleConnection },
    ];
  });

  test("both built-in samples can start a run", () => {
    expect(builders).toHaveLength(2);

    for (const { seedId, build } of builders) {
      const served = JSON.parse(JSON.stringify(build())) as ManagedConnectionPayload;
      const stored = browserCopy(served);

      expect(startableId(stored)).toBe(`seed:${seedId}`);
    }
  });
});

/**
 * `buildConnectionPayload` — the other question, and the reason it belongs beside this
 * one: both decide what a request body may say about a connection, and they disagree
 * on purpose. The managed arm is a credential boundary, not a formatting choice: a
 * seed travels as a bare `seed:<id>` reference so nothing about how to authenticate
 * leaves the server's own configuration, and a browser-held connection has to travel
 * whole because the server has no other way to reach it.
 *
 * Pinned here rather than in a file of its own because this is the process that
 * measures this module: a test that only loads it records no line data for it at all.
 */
describe("what a request body says about a connection", () => {
  const plain = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
    id: "conn-1",
    name: "Sales",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "reader",
    password: "secret",
    database: "sales",
    createdAt: new Date(0),
    ...overrides,
  });

  test("a managed connection travels as a seed reference, carrying no credential", () => {
    const payload = buildConnectionPayload(plain({ managed: true, seedId: "sales" }));

    expect(payload).toEqual({ connectionId: "seed:sales" });
    // The point of the arm, asserted rather than assumed: nothing about how to
    // authenticate is in the body at all.
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  // docs/CONTEXT.md §4.1: no connection travels whole any more. A row with no seed id can
  // only be stale browser state from before that change; its own id goes out and the server
  // answers 400 - never a credential, whatever the row holds.
  test("a connection with no seed id travels as its own id, carrying no credential", () => {
    const payload = buildConnectionPayload(plain());
    expect(payload).toEqual({ connectionId: "conn-1" });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("a seedId is a seed reference whatever `managed` says: editable copies no longer exist", () => {
    expect(buildConnectionPayload(plain({ seedId: "sales" }))).toEqual({ connectionId: "seed:sales" });
  });

  test("`managed` with no seedId falls back to the row's own id", () => {
    expect(buildConnectionPayload(plain({ managed: true }))).toEqual({ connectionId: "conn-1" });
  });
});
