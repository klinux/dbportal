/**
 * A provider that shows one session only the objects its scope allows (docs/CONTEXT.md §4.56).
 *
 * Visibility is applied HERE, on the provider every object route and the agent's
 * grounding read through, rather than in each route: a route that forgot the filter
 * would list what the rules hide, and the tree, the autocomplete, the schema diff and
 * the agent all read the same five methods. An unrestricted scope returns the provider
 * itself, so a datasource without rules costs nothing.
 *
 * What is filtered: the listing, the counts (recounted from the listing, because a
 * number the engine reports counts what the rules hide), the single detail (a hidden
 * object is "not found", the same answer as an object that does not exist - a refusal
 * that said "hidden" would confirm the name) and the batch detail. Containers are not:
 * a schema is an address, not an object, and an empty folder says what the rules did.
 *
 * Monitoring reads through the same filter: a table's and an index's statistics by the
 * table's address, and a slow query or an active session by the statement it carries -
 * kept only when the statement names nothing the scope hides, judged by the same scanner
 * the execution gate uses, and dropped when it cannot be read at all (an idle marker, a
 * command on an engine whose language is not SQL). A statement someone else ran is the
 * one place a hidden name could otherwise still appear.
 */
import type {
  ActiveSessionDetails,
  DatabaseObject,
  DatabaseProvider,
  IndexStats,
  KindCount,
  MonitoringData,
  MonitoringOptions,
  ObjectDetail,
  ObjectDetailBatch,
  SlowQueryStats,
  TableStats,
} from "@/lib/db/types";
import { containerDepth, declaredKinds, isCountUnavailable } from "@/lib/db/object-kinds";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { referencedObjects } from "@/lib/sql/referenced-objects";
import { type ObjectScope, pathVisible, referenceVerdict } from "./rules";

/** A detail read of an object the scope hides. Answered as not found, deliberately. */
export class ObjectHiddenError extends Error {
  public readonly status = 404;
  constructor(path: readonly string[], kind: string) {
    super(`No ${kind} named ${path[path.length - 1] ?? ""}`);
    this.name = "ObjectHiddenError";
  }
}

export function scopeProvider(provider: DatabaseProvider, scope: ObjectScope): DatabaseProvider {
  if (!scope.restricted) return provider;
  const depth = containerDepth(provider.getCapabilities());
  const visible = (object: { readonly path: readonly string[] }): boolean => pathVisible(scope, object.path, depth);

  const listObjects = async (container: readonly string[], kind: string): Promise<DatabaseObject[]> =>
    (await provider.listObjects(container, kind)).filter(visible);

  const countObjects = async (container: readonly string[]): Promise<Record<string, KindCount>> => {
    const counts = await provider.countObjects(container);
    const recounted: Record<string, KindCount> = {};
    for (const kind of declaredKinds(provider.getCapabilities())) {
      const count = counts[kind.id];
      // A kind the engine would not count stays unavailable, in the engine's words; a kind
      // it did count is recounted from what the scope shows of it. A sampled count is
      // replaced by the exact count of the sample the listing returns.
      if (count === undefined || isCountUnavailable(count)) {
        if (count !== undefined) recounted[kind.id] = count;
        continue;
      }
      recounted[kind.id] = { count: (await listObjects(container, kind.id)).length };
    }
    return recounted;
  };

  const describeObject = async (path: readonly string[], kind: string): Promise<ObjectDetail> => {
    if (!visible({ path })) throw new ObjectHiddenError(path, kind);
    return provider.describeObject(path, kind);
  };

  const describeObjects = async (container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> => {
    const batch = await provider.describeObjects(container, kind, limit);
    return { ...batch, details: batch.details.filter(visible) };
  };

  // A statistics row names its table by schema and name; an engine with no containers
  // reports an empty schema (measured on the search products), so the address is the
  // name alone there, and a deeper engine's row is judged at the depth the row has.
  const tableVisible = (row: { readonly schemaName: string; readonly tableName: string }): boolean => {
    const path = row.schemaName === "" ? [row.tableName] : [row.schemaName, row.tableName];
    return pathVisible(scope, path, Math.min(depth, path.length - 1));
  };
  const grammar = readsSqlText(provider.type) ? resolveSqlGrammar(provider.type) : null;
  const statementVisible = (sql: string): boolean => {
    if (grammar === null) return false;
    const found = referencedObjects(sql, grammar);
    if (found.opaque !== undefined) return false;
    return found.references.every((reference) => referenceVerdict(scope, reference, undefined, depth) === null);
  };
  const getTableStats = async (options?: { schema?: string }): Promise<TableStats[]> =>
    (await provider.getTableStats(options)).filter(tableVisible);
  const getIndexStats = async (options?: { schema?: string }): Promise<IndexStats[]> =>
    (await provider.getIndexStats(options)).filter(tableVisible);
  const getSlowQueries = async (options?: { limit?: number }): Promise<SlowQueryStats[]> =>
    (await provider.getSlowQueries(options)).filter((entry) => statementVisible(entry.query));
  const getActiveSessions = async (options?: { limit?: number }): Promise<ActiveSessionDetails[]> =>
    (await provider.getActiveSessions(options)).filter((session) => statementVisible(session.query));
  const getMonitoringData = async (options?: MonitoringOptions): Promise<MonitoringData> => {
    const data = await provider.getMonitoringData(options);
    return {
      ...data,
      ...(data.tables === undefined ? {} : { tables: data.tables.filter(tableVisible) }),
      ...(data.indexes === undefined ? {} : { indexes: data.indexes.filter(tableVisible) }),
      ...(data.slowQueries === undefined ? {} : { slowQueries: data.slowQueries.filter((e) => statementVisible(e.query)) }),
      ...(data.activeSessions === undefined
        ? {}
        : { activeSessions: data.activeSessions.filter((s) => statementVisible(s.query)) }),
    };
  };

  return new Proxy(provider, {
    get(target, property, receiver) {
      switch (property) {
        case "listObjects":
          return listObjects;
        case "countObjects":
          return countObjects;
        case "describeObject":
          return describeObject;
        case "describeObjects":
          return describeObjects;
        case "getTableStats":
          return getTableStats;
        case "getIndexStats":
          return getIndexStats;
        case "getSlowQueries":
          return getSlowQueries;
        case "getActiveSessions":
          return getActiveSessions;
        case "getMonitoringData":
          return getMonitoringData;
        default: {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      }
    },
  });
}
