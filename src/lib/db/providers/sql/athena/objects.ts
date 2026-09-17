/**
 * The Athena object surface (#789)
 *
 * The pure derivations behind `listContainers`, `countObjects`, `listObjects`,
 * `describeObject` and `describeObjects`. The five methods themselves live on the
 * provider in `index.ts`; nothing here holds a transport, so every function below is
 * a pure function of a declaration, a path and what the catalog answered.
 *
 * Athena is a ONE-level engine: a Glue Data Catalog holds databases, and a database
 * holds tables and views. The catalog itself is pinned by the connection
 * (`ATHENA_DEFAULT_CATALOG`) rather than declared as a level, because a federated
 * catalog is reached by qualifying a name in SQL and never by browsing.
 *
 * Two facts about the catalog shape everything here:
 *
 * - **A TABLE'S TYPE IS FREE TEXT.** Glue's `TableType` is a string set by whoever
 *   registered the table: a crawler writes `EXTERNAL_TABLE`, an Iceberg table is
 *   `EXTERNAL_TABLE` with a `table_type` parameter, a Lake Formation governed table
 *   is `GOVERNED`, a CTAS answers `EXTERNAL_TABLE`, and a view is `VIRTUAL_VIEW`. Every
 *   spelling but the view's is a relation a statement can SELECT from, so the kind is
 *   decided by the ONE spelling that means "not a table" rather than by a list of the
 *   spellings that mean "table" - a list would turn a spelling nobody here has seen
 *   into an object missing from the tree, which is the defect shape standing ruling 5a
 *   (#789) names as the worst one.
 * - **THE PARTITION KEYS ARE COLUMNS.** The catalog keeps them apart from the data
 *   columns, and a statement addresses them exactly like one: `WHERE dt = '2026-01-01'`
 *   is how a partitioned table is read cheaply. They are listed after the data columns,
 *   in the catalog's order, which is the order `DESCRIBE` prints them in.
 *
 * There is NO identifier interpolation anywhere here: every read is an API call
 * that takes the database and the table as parameters, so a name reaches the
 * service as a value and never as SQL text.
 */

import { QueryError } from "@/lib/db/errors";
import { containerDepth } from "@/lib/db/object-kinds";
import type {
  ColumnSchema,
  ContainerLevelSpec,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import type { AthenaTable } from "./transport";

/** The canonical type-id, for the errors raised here. */
const TYPE_ID = "athena";

// ============================================================================
// The kind vocabulary, derived from the CATALOG
// ============================================================================

/** The kind id a table is declared and addressed under. */
export const ATHENA_TABLE_KIND = "table";

/** The kind id a view is declared and addressed under. */
export const ATHENA_VIEW_KIND = "view";

/**
 * The one `TableType` spelling that is not a table.
 *
 * Glue writes exactly this for a view created through Athena (`CREATE VIEW`), and
 * it is the only spelling the catalog reserves; see the module header for why the
 * reading is "this one is a view, everything else is a table" rather than the
 * reverse.
 */
const VIEW_TABLE_TYPE = "VIRTUAL_VIEW";

/** The kind one catalog entry belongs to. */
export function kindOf(table: AthenaTable): string {
  return table.tableType === VIEW_TABLE_TYPE ? ATHENA_VIEW_KIND : ATHENA_TABLE_KIND;
}

// ============================================================================
// Derivations over the declaration
// ============================================================================

/**
 * The container levels this engine declares, cut to the depth `containerDepth()` answers.
 *
 * Every derivation below starts here rather than from a length or an index, which is
 * standing ruling 5g (#789): NEVER index `path` or `container` positionally.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/** The segment of one declared level, read by the level's id. */
function segmentOf(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  level: ContainerLevelSpec["id"],
): string {
  const at = declaredLevels(capabilities).findIndex((declared) => declared.id === level);
  const segment = at === -1 ? undefined : path[at];
  if (segment === undefined) {
    throw new QueryError(`Athena declares no ${level} level to read this path's segment from`, TYPE_ID);
  }
  return segment;
}

/** The container shape this engine accepts, spelled for a message: `[schema]`. */
function shapeOf(capabilities: ProviderCapabilities): string {
  return `[${declaredLevels(capabilities)
    .map((level) => level.id)
    .join(", ")}]`;
}

/**
 * One container path resolved into the database it names.
 *
 * It raises rather than reading what it can: a container one segment too long
 * would otherwise bind the object's own name as a database and answer an empty
 * folder that looks exactly like a database holding nothing.
 */
export function containerRead(capabilities: ProviderCapabilities, container: readonly string[]): string {
  if (container.length !== containerDepth(capabilities)) {
    throw new QueryError(
      `An Athena container path is ${shapeOf(capabilities)}, received ${JSON.stringify(container)}`,
      TYPE_ID,
    );
  }
  return segmentOf(capabilities, container, "schema");
}

/** One object path resolved into the database and the name a detail read needs, checked first. */
export interface AthenaObjectRead {
  readonly database: string;
  readonly name: string;
}

export function objectRead(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  path: readonly string[],
): AthenaObjectRead {
  if (spec.attachedTo !== undefined) {
    throw new QueryError(
      `Athena holds no object attached to another, so the kind "${spec.id}" cannot declare attachedTo "${spec.attachedTo}"`,
      TYPE_ID,
    );
  }
  if (path.length !== containerDepth(capabilities) + 1) {
    throw new QueryError(
      `An Athena "${spec.id}" path is ${shapeOf(capabilities).slice(0, -1)}, name], received ${JSON.stringify(path)}`,
      TYPE_ID,
    );
  }
  return { database: segmentOf(capabilities, path, "schema"), name: path[path.length - 1] };
}

// ============================================================================
// Count assembly and row mapping
// ============================================================================

/**
 * Every declared kind seeded at zero, before any entry is read.
 *
 * Seeding is what makes "this engine has this kind and this database holds none"
 * render as a 0 badge; an absent kind means the engine has no such concept.
 */
export function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * The counts one listing answers, and whether they are floors.
 *
 * A listing that stopped at the transport's ceiling counted what it saw and not what
 * the database holds, so every kind's number is a FLOOR and is carried as one:
 * `{ count, sampledFrom }` is the fourth `KindCount` state and the tree badges it
 * `1,204+` (#789). The sentence names the bound in the catalog's own terms.
 */
export function countsFrom(
  kinds: readonly ObjectKindSpec[],
  tables: readonly AthenaTable[],
  truncatedAt: number | null,
): Record<string, KindCount> {
  const counts = seedZeroCounts(kinds);
  const tally = new Map<string, number>();
  for (const table of tables) {
    const kind = kindOf(table);
    tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  for (const kind of kinds) {
    const count = tally.get(kind.id) ?? 0;
    counts[kind.id] =
      truncatedAt === null ? { count } : { count, sampledFrom: `the first ${truncatedAt} tables the catalog listed` };
  }
  return counts;
}

/**
 * One catalog entry as the object it addresses.
 *
 * The path is CONSTRUCTED here, which standing ruling 5g (#789) names as the one place
 * a position is legitimately written rather than derived - and it is written in the
 * DECLARED order, because `objectRead()` reads the same path back by level.
 */
export function listedObject(capabilities: ProviderCapabilities, database: string, table: AthenaTable): DatabaseObject {
  const segments: Record<ContainerLevelSpec["id"], string> = { catalog: database, schema: database };
  return {
    path: [...declaredLevels(capabilities).map((level) => segments[level.id]), table.name],
    name: table.name,
    kind: kindOf(table),
  };
}

/**
 * ONE object's detail from its catalog entry, for BOTH reads (#789).
 *
 * One mapper and not two, because two are two chances for `describeObjects` to spell
 * a column differently from `describeObject` over the same object.
 *
 * `nullable` is true for every column: Glue records no nullability, and Athena's own
 * `information_schema.columns` answers `YES` for every column of every table, so this
 * is the catalog's answer rather than a default chosen here. `isPrimary` is false for
 * the same reason: no key exists in the model. Indexes and foreign keys are empty by
 * construction.
 */
export function objectDetailFromTable(path: readonly string[], table: AthenaTable): ObjectDetail {
  const column = (entry: { name: string; type: string }): ColumnSchema => ({
    name: entry.name,
    type: entry.type,
    nullable: true,
    isPrimary: false,
  });
  return {
    path: [...path],
    columns: [...table.columns.map(column), ...table.partitionKeys.map(column)],
    indexes: [],
    foreignKeys: [],
  };
}
