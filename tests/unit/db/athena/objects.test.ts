/**
 * The Athena object surface's pure derivations (#789)
 *
 * Every function in objects.ts is a pure function of a declaration, a path and what
 * the catalog answered, so each is pinned here against hand-built catalog entries.
 * The shape of the catalog's own answers - a free-text `TableType`, partition keys
 * kept apart from the columns, a property bag with statistics in it - is what these
 * tests reproduce.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { AthenaProvider } from "@/lib/db/providers/sql/athena/index";
import {
  ATHENA_TABLE_KIND,
  ATHENA_VIEW_KIND,
  containerRead,
  countsFrom,
  kindOf,
  listedObject,
  objectDetailFromTable,
  objectRead,
  seedZeroCounts,
} from "@/lib/db/providers/sql/athena/objects";
import type { AthenaTable } from "@/lib/db/providers/sql/athena/transport";
import type { ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";

const CAPABILITIES: ProviderCapabilities = new AthenaProvider({
  id: "athena-1",
  name: "Lake",
  type: "athena",
  region: "us-east-1",
  createdAt: new Date(),
}).getCapabilities();

const KINDS = CAPABILITIES.objectKinds ?? [];

function table(overrides: Partial<AthenaTable> = {}): AthenaTable {
  return {
    name: "orders",
    tableType: "EXTERNAL_TABLE",
    columns: [
      { name: "id", type: "bigint" },
      { name: "total", type: "decimal(12,2)" },
    ],
    partitionKeys: [{ name: "dt", type: "string" }],
    parameters: {},
    ...overrides,
  };
}

describe("kindOf", () => {
  // Glue's TableType is free text set by whoever registered the table, and every
  // spelling but the view's is a relation a statement can SELECT from.
  test.each(["EXTERNAL_TABLE", "MANAGED_TABLE", "GOVERNED", "ICEBERG", "anything-a-crawler-wrote"])(
    "reads %s as a table",
    (tableType) => {
      expect(kindOf(table({ tableType }))).toBe(ATHENA_TABLE_KIND);
    },
  );

  test("reads VIRTUAL_VIEW as a view, which is the one spelling the catalog reserves", () => {
    expect(kindOf(table({ tableType: "VIRTUAL_VIEW" }))).toBe(ATHENA_VIEW_KIND);
  });

  test("reads an entry with no recorded type as a table rather than dropping it", () => {
    expect(kindOf(table({ tableType: null }))).toBe(ATHENA_TABLE_KIND);
  });
});

describe("containerRead", () => {
  test("resolves the one declared level into the database it names", () => {
    expect(containerRead(CAPABILITIES, ["analytics"])).toBe("analytics");
  });

  test("refuses a path of the wrong depth rather than binding an object's name as a database", () => {
    expect(() => containerRead(CAPABILITIES, [])).toThrow(QueryError);
    expect(() => containerRead(CAPABILITIES, ["analytics", "orders"])).toThrow(/\[schema\], received/);
  });

  // A declaration that names no level at all has no segment to read; the refusal
  // names the level rather than interpolating `undefined` into a request.
  test("refuses a declaration that carries no schema level", () => {
    const levelless: ProviderCapabilities = { ...CAPABILITIES, containerLevels: [] };

    expect(() => containerRead(levelless, [])).toThrow(/declares no schema level/);
  });
});

describe("objectRead", () => {
  const tableSpec = KINDS.find((kind) => kind.id === ATHENA_TABLE_KIND)!;

  test("resolves a database-and-name path", () => {
    expect(objectRead(CAPABILITIES, tableSpec, ["analytics", "orders"])).toEqual({
      database: "analytics",
      name: "orders",
    });
  });

  test("refuses a path of the wrong length, naming the shape it takes", () => {
    expect(() => objectRead(CAPABILITIES, tableSpec, ["orders"])).toThrow(/\[schema, name\], received/);
    expect(() => objectRead(CAPABILITIES, tableSpec, ["a", "b", "c"])).toThrow(QueryError);
  });

  // Athena holds no trigger, no index and no constraint, so nothing hangs off another
  // object and a kind declaring `attachedTo` would draw a folder no path resolves in.
  test("refuses a kind that declares itself attached to another object", () => {
    const attached: ObjectKindSpec = {
      id: "trigger",
      role: "relation",
      label: "T",
      labelPlural: "Ts",
      attachedTo: "table",
    };

    expect(() => objectRead(CAPABILITIES, attached, ["a", "b", "c"])).toThrow(/cannot declare attachedTo/);
  });
});

describe("counts", () => {
  test("seeds every declared kind at zero, so an empty database renders a 0 badge per folder", () => {
    expect(seedZeroCounts(KINDS)).toEqual({ table: { count: 0 }, view: { count: 0 } });
  });

  test("tallies each entry under its kind", () => {
    const counts = countsFrom(
      KINDS,
      [table(), table({ name: "customers" }), table({ tableType: "VIRTUAL_VIEW" })],
      null,
    );

    expect(counts).toEqual({ table: { count: 2 }, view: { count: 1 } });
  });

  // A listing the transport's ceiling cut counted what it saw and not what the
  // database holds, so every number is a FLOOR and the tree badges it `N+` (#789).
  test("marks every count as a floor when the listing stopped at the ceiling", () => {
    const counts = countsFrom(KINDS, [table()], 10_000);

    expect(counts.table).toEqual({ count: 1, sampledFrom: "the first 10000 tables the catalog listed" });
    expect(counts.view).toEqual({ count: 0, sampledFrom: "the first 10000 tables the catalog listed" });
  });
});

describe("listedObject", () => {
  test("addresses the entry under the database, labelled by its own name", () => {
    expect(listedObject(CAPABILITIES, "analytics", table())).toEqual({
      path: ["analytics", "orders"],
      name: "orders",
      kind: "table",
    });
    expect(listedObject(CAPABILITIES, "analytics", table({ tableType: "VIRTUAL_VIEW" })).kind).toBe("view");
  });
});

describe("objectDetailFromTable", () => {
  test("lists the data columns and then the partition keys, each nullable and none primary", () => {
    expect(objectDetailFromTable(["analytics", "orders"], table())).toEqual({
      path: ["analytics", "orders"],
      columns: [
        { name: "id", type: "bigint", nullable: true, isPrimary: false },
        { name: "total", type: "decimal(12,2)", nullable: true, isPrimary: false },
        { name: "dt", type: "string", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    });
  });

  test("copies the path rather than aliasing the caller's array", () => {
    const path = ["analytics", "orders"];
    const detail = objectDetailFromTable(path, table({ columns: [], partitionKeys: [] }));
    path.push("mutated");

    expect(detail.path).toEqual(["analytics", "orders"]);
    expect(detail.columns).toEqual([]);
  });
});
