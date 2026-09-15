import type { DatabaseConnection, QueryResult } from "@/lib/types";
import type { Container, ProviderCapabilities, ProviderExecutionContext, ProviderOptions } from "../../types";
import { DatabaseConfigError, QueryError } from "../../errors";
import { isReadStatement } from "@/lib/access";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { findCodeWord } from "@/lib/sql/words";
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed/types";
import { DuckDBProvider, assertReadOnlyStatementIsBounded, mapDuckDBError } from "../sql/duckdb";
import type { DuckDBClient } from "../sql/duckdb/client";
import { openVirtualClient } from "./client";

/**
 * A virtual datasource (docs/CONTEXT.md §4.44): its members, PostgreSQL and MySQL
 * datasources declared on their own, opened as one through an embedded DuckDB session so
 * a statement joins `orders.public.pedidos` with `crm.proto_crm.clientes`.
 *
 * The session is the boundary. It opens in memory with a memory ceiling and a thread
 * count, loads the two extensions the image ships, attaches every member READ_ONLY under
 * the credential the person resolved for it, and then locks itself: external access off
 * and the configuration frozen, so the person's SQL can attach nothing, load nothing and
 * read no file - measured on DuckDB 1.5.5, see docs/providers/virtual.md. On top of that
 * lock, a statement is refused before the engine sees it when it is not a read, when it
 * carries one of the DuckDB read-only profile's forbidden words, or when it reaches for
 * the pass-through functions that would hand raw SQL to a member.
 *
 * The session lives in a child process (`client.ts`, `runner.mjs`): the extensions and the
 * remote attaches are native code, a fault there is a segfault, and a segfault in the
 * studio would take every session with it. In the child it ends one session, and the
 * person is told the session is gone.
 *
 * Nothing is persisted: `:memory:` is the database, the members are the data, and the
 * provider cache holds one session per person per virtual datasource, as for any engine.
 */
export const VIRTUAL_MEMORY_LIMIT = "512MB";
export const VIRTUAL_THREADS = "4";
const MEMBER_EXTENSION: Record<string, string> = { postgres: "postgres", mysql: "mysql" };

/** Beyond the DuckDB read-only words: the functions that hand raw SQL to a member, and DDL in the session. */
export const VIRTUAL_FORBIDDEN_WORDS: ReadonlyArray<{ word: string; reason: string }> = [
  { word: "POSTGRES_QUERY", reason: "postgres_query hands raw SQL to a member" },
  { word: "MYSQL_QUERY", reason: "mysql_query hands raw SQL to a member" },
  { word: "POSTGRES_EXECUTE", reason: "postgres_execute hands raw SQL to a member" },
  { word: "MYSQL_EXECUTE", reason: "mysql_execute hands raw SQL to a member" },
  { word: "CREATE", reason: "a virtual datasource holds no object of its own" },
  { word: "USE", reason: "the session's default catalog is fixed" },
  { word: "SET", reason: "the session's configuration is locked" },
  { word: "RESET", reason: "the session's configuration is locked" },
  { word: "PRAGMA", reason: "the session's configuration is locked" },
  { word: "CALL", reason: "a procedure could reach past the members" },
];

/** A libpq connection-string value: single-quoted, backslash and quote escaped. */
export function libpqValue(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The DuckDB ATTACH string for one member; a MySQL value the extension's parser cannot quote is refused. */
export function attachString(member: DatabaseConnection): string {
  const pairs: string[] = [];
  const add = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return;
    pairs.push(`${key}=${libpqValue(String(value))}`);
  };
  if (member.type === "postgres") {
    add("host", member.host);
    add("port", member.port);
    add("dbname", member.database);
    add("user", member.user);
    add("password", member.password);
    const mode = member.ssl?.mode;
    if (mode) add("sslmode", mode === "verify-system" ? "verify-full" : mode);
    return pairs.join(" ");
  }
  // The MySQL extension reads bare key=value pairs; a value with a space or a quote has
  // no safe spelling, so the member is refused rather than attached under another name.
  const plain: [string, string | number | undefined][] = [
    ["host", member.host],
    ["port", member.port],
    ["database", member.database],
    ["user", member.user],
    ["password", member.password],
  ];
  for (const [key, value] of plain) {
    if (value === undefined || value === "") continue;
    const text = String(value);
    if (/[\s'"\\]/.test(text)) {
      throw new DatabaseConfigError(
        `Member "${member.name}" has a ${key} the MySQL attach cannot carry (a space or a quote); change it on the member`,
        "virtual",
      );
    }
    pairs.push(`${key}=${text}`);
  }
  return pairs.join(" ");
}

/** A SQL string literal of the attach string. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export class VirtualProvider extends DuckDBProvider {
  private readonly members: ManagedConnection[];

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    const members = (config as ManagedConnection).memberConnections ?? [];
    super({ ...config, database: ":memory:" }, options, execution);
    this.members = members;
    if (members.length < 2) {
      throw new DatabaseConfigError("A virtual datasource needs at least two resolved members", "virtual");
    }
    for (const member of members) {
      if (!(member.type in MEMBER_EXTENSION)) {
        throw new DatabaseConfigError(`A virtual datasource cannot join a ${member.type} member`, "virtual");
      }
    }
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsInlineRowEdit: false,
      supportsTransactions: false,
      singleWriterFile: false,
      maintenanceOperations: [],
      maintenanceOperationSpecs: {},
      containerLevels: [
        { id: "catalog", label: "Member", labelPlural: "Members" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    };
  }

  /** The statements that make the session (§4.44): the extensions, every member attached read-only, then the lock. */
  public bootstrapStatements(): string[] {
    const statements: string[] = [];
    for (const extension of new Set(this.members.map((m) => MEMBER_EXTENSION[m.type]))) {
      statements.push(`LOAD ${extension}`);
    }
    for (const member of this.members) {
      const alias = member.seedId ?? member.id.replace(/^seed:/, "");
      statements.push(
        `ATTACH ${literal(attachString(member))} AS ${quoteIdentifier(alias)} (TYPE ${MEMBER_EXTENSION[member.type]}, READ_ONLY)`,
      );
    }
    // The lock: nothing the person writes can attach, load, read a file or change a
    // setting from here on - the engine refuses, whatever the word list misses.
    statements.push("SET enable_external_access = false", "SET lock_configuration = true");
    return statements;
  }

  /** The session: opened in its own process, the extensions loaded, every member attached read-only, then locked. */
  public override async connect(): Promise<void> {
    if (this.client) return;
    // Named before the open, not by the constant the open assigns: a child that dies while
    // opening reports itself before that assignment exists, and a closure over the constant
    // then throws a ReferenceError inside the child's exit handler - an uncaught exception.
    let session: DuckDBClient | null = null;
    try {
      const client = await openVirtualClient(
        this.bootstrapStatements(),
        {
          memory_limit: VIRTUAL_MEMORY_LIMIT,
          threads: VIRTUAL_THREADS,
          ...(process.env.DUCKDB_EXTENSION_DIR?.trim()
            ? { extension_directory: process.env.DUCKDB_EXTENSION_DIR.trim() }
            : {}),
        },
        {
          // A child that died leaves no client behind: the provider cache sees a provider that
          // is not connected and opens a new session on the next request.
          onGone: () => {
            if (session !== null && this.client === session) {
              this.client = null;
              this.setConnected(false);
            }
          },
        },
      );
      session = client;
      this.client = client;
      this.setConnected(true);
      logger.debug("Virtual datasource session opened", {
        route: "db/virtual",
        connectionId: this.config.id,
        members: this.members.map((m) => m.seedId ?? m.id),
      });
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw mapDuckDBError(error);
    }
  }

  /**
   * The members are the catalogs (§4.44): the session's own in-memory database holds
   * nothing and is left out, and the first member stands in for the session default -
   * with its first schema marked too - so the explorer's first paint (ruling 5a2, #789)
   * opens somewhere real.
   */
  public override async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const listed = await super.listContainers(parent);
    const first = this.members[0];
    const alias = (m: ManagedConnection) => m.seedId ?? m.id.replace(/^seed:/, "");
    if (!parent || parent.length === 0) {
      const names = new Set(this.members.map(alias));
      return listed
        .filter((c) => names.has(c.name))
        .sort(
          (a, b) =>
            this.members.findIndex((m) => alias(m) === a.name) - this.members.findIndex((m) => alias(m) === b.name),
        )
        .map((c) => ({ ...c, isSessionDefault: c.name === alias(first) }));
    }
    if (parent.length === 1) {
      const member = this.members.find((m) => alias(m) === parent[0]);
      // A MySQL member attaches the whole server its credential sees; the explorer shows
      // the database the member declares, which is what the member is.
      const shown =
        member?.type === "mysql" && member.database ? listed.filter((c) => c.name === member.database) : listed;
      if (member === first) {
        const home = first.type === "mysql" ? first.database : "public";
        return shown.map((c) => ({ ...c, isSessionDefault: c.name === home }));
      }
      return shown.map((c) => ({ ...c, isSessionDefault: false }));
    }
    return listed.map((c) => ({ ...c, isSessionDefault: false }));
  }

  /** Read-only, always: the rule (§4.4) and the profile's word list both apply before the engine. */
  public override async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    assertVirtualStatement(sql);
    return super.query(sql, params, queryId);
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** What a virtual datasource refuses before the engine sees it. */
export function assertVirtualStatement(sql: string): void {
  if (!isReadStatement(sql, "duckdb")) {
    throw new QueryError(
      "A virtual datasource only reads: SELECT, WITH, SHOW, DESCRIBE or an EXPLAIN of one",
      "virtual",
      sql,
    );
  }
  assertReadOnlyStatementIsBounded(sql);
  const grammar = resolveSqlGrammar("duckdb");
  for (const { word, reason } of VIRTUAL_FORBIDDEN_WORDS) {
    if (findCodeWord(sql, word, 0, grammar) !== null) {
      throw new QueryError(`A virtual datasource refused ${word}: ${reason}`, "virtual", sql);
    }
  }
}
