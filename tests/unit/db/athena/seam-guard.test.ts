/**
 * Athena transport seam guard
 *
 * The Athena provider stays testable without a network, and replaceable behind
 * its seam, only while the AWS SDK lives in exactly one file. This test is the
 * mechanism that keeps that true: it parses every source in the provider
 * directory and fails the build the moment the SDK's vocabulary - the package
 * itself, a command class, a field of the wire model, a pagination token - is
 * used outside `sdk-transport.ts`. It reads the directory from disk rather than
 * from a list, so it keeps holding as the provider grows. The model is
 * `tests/unit/db/trino/seam-guard.test.ts`, whose vocabulary is HTTP rather than
 * an SDK.
 *
 * The guard is a parser, not a grep, and the vocabulary is sorted into two
 * classes: identifiers that exist nowhere else in this provider and nowhere in
 * English (`QueryExecutionId`, `VarCharValue`, `NextToken`), matched as a
 * substring of any identifier or string; and the package specifier, matched
 * only in an import. Comments are trivia rather than nodes, so prose naming the
 * SDK is deliberately free - the point is that no code depends on it.
 *
 * Both directions are proven below: the detector must light up on the file that
 * is SUPPOSED to speak the SDK, and stay silent on a compliant one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "athena");

/** The single file allowed to know the SDK. */
const TRANSPORT_FILE = "sdk-transport.ts";

/** The package, matched only where a module is named. */
const SDK_PACKAGE = "@aws-sdk/client-athena";

/**
 * Vocabulary that exists nowhere else in this provider and nowhere in English:
 * the client, every command class the transport sends, the members of a query
 * execution, a result page and a table's metadata, and the pagination token.
 *
 * Matched case-insensitively as a substring, because `queryExecutionId` on the
 * neutral result is the same word as the wire's `QueryExecutionId` - which is
 * why the neutral result's OWN spelling is listed in `NEUTRAL_SPELLINGS` below.
 */
const SDK_TOKENS = [
  "AthenaClient",
  "StartQueryExecutionCommand",
  "GetQueryExecutionCommand",
  "GetQueryResultsCommand",
  "StopQueryExecutionCommand",
  "ListDatabasesCommand",
  "ListTableMetadataCommand",
  "GetTableMetadataCommand",
  "GetWorkGroupCommand",
  "ListQueryExecutionsCommand",
  "BatchGetQueryExecutionCommand",
  "StateChangeReason",
  "VarCharValue",
  "ResultSetMetadata",
  "ColumnInfo",
  "TableMetadataList",
  "DatabaseList",
  "QueryExecutionIds",
  "NextToken",
  "ClientRequestToken",
  "EngineExecutionTimeInMillis",
  "DataScannedInBytes",
  "EnforceWorkGroupConfiguration",
  "BytesScannedCutoffPerQuery",
  "EffectiveEngineVersion",
];

/**
 * The neutral seam's own words that happen to CONTAIN an SDK token, and are
 * therefore exempt: `queryExecutionId` is the id every client of the service
 * learns and the seam carries it under its own camel case.
 */
const NEUTRAL_SPELLINGS = new Set(["queryExecutionId", "queryexecutionid"]);

/** Everything the transport must speak, and nothing else may. */
const SDK_VOCABULARY = [...SDK_TOKENS, SDK_PACKAGE];

const SEAM_RULE = [
  `The AWS SDK leaked out of ${TRANSPORT_FILE}.`,
  "",
  "An Athena statement is a job: it is started, polled to a terminal state, and its rows are read page by",
  "page through the SDK's command classes, with every cell as text and a header row on a DML result. All of",
  "that stays inside the transport: provider logic reads the neutral AthenaQueryResult (rows, fieldNames,",
  "columnTypes, queryExecutionId, statementType, affectedRows, stats), the neutral catalog shapes",
  "(AthenaDatabase, AthenaTable, AthenaWorkgroupInfo, AthenaExecutionSummary) and the classified",
  "AthenaTransportError through the AthenaTransport seam. That is what lets every test hand the provider a",
  "fake client, and what keeps the SDK a dependency of one file.",
  "",
  `Fix an access below by mapping the member inside ${TRANSPORT_FILE} and widening the neutral type when the`,
  "value is genuinely needed. Do not weaken or delete this test - it is the only thing keeping the seam real.",
  "",
  "SDK vocabulary outside the transport:",
].join("\n");

interface SdkLeak {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

function spelling(node: ts.Node): { text: string; isModuleName: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
    return {
      text: node.text,
      isModuleName: ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent),
    };
  }
  if (ts.isIdentifier(node)) return { text: node.text, isModuleName: false };
  return null;
}

/** One spelling can match two tokens when one contains the other; only the longest survives. */
function mostSpecific(matches: string[]): string[] {
  return matches.filter(
    (token) => !matches.some((other) => other !== token && other.toLowerCase().includes(token.toLowerCase())),
  );
}

function leakedTokens(node: ts.Node): string[] {
  const spelled = spelling(node);
  if (!spelled) return [];
  if (NEUTRAL_SPELLINGS.has(spelled.text)) return [];

  const lowered = spelled.text.toLowerCase();
  return mostSpecific([
    ...SDK_TOKENS.filter((token) => lowered.includes(token.toLowerCase())),
    ...(spelled.isModuleName && spelled.text === SDK_PACKAGE ? [SDK_PACKAGE] : []),
  ]);
}

function findSdkLeaks(file: string, source: string): SdkLeak[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const found = new Map<string, SdkLeak>();

  const visit = (node: ts.Node): void => {
    for (const token of leakedTokens(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.set(`${line}:${token}`, { file, line: line + 1, token, snippet: lines[line].trim() });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function violationReport(leaks: SdkLeak[]): string {
  if (leaks.length === 0) return "";

  const offences = leaks.map((leak) => `  ${leak.file}:${leak.line} uses "${leak.token}" -> ${leak.snippet}`);
  return [SEAM_RULE, ...offences].join("\n");
}

function providerSources(): string[] {
  return readdirSync(PROVIDER_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

function readProviderSource(file: string): string {
  return readFileSync(join(PROVIDER_DIR, file), "utf8");
}

describe("Athena transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one,
  // so the file that is SUPPOSED to speak the SDK must light it up on every token.
  test.each(SDK_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findSdkLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the SDK is used only in ${TRANSPORT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findSdkLeaks(file, readProviderSource(file)));

    expect(violationReport(leaks)).toBe("");
  });

  // The seam's whole point: the SDK is a dependency of one file, and the provider
  // takes its transport through the seam's interface.
  test("only the transport imports the package, and the provider imports the seam", () => {
    const importers = sources.filter((file) =>
      findSdkLeaks(file, readProviderSource(file)).some((leak) => leak.token === SDK_PACKAGE),
    );

    expect(importers).toEqual([TRANSPORT_FILE]);
    expect(readProviderSource("index.ts")).toContain('from "./transport"');
  });
});

describe("the seam guard detector", () => {
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the SDK: sdk-transport.ts sends StartQueryExecution, polls
 * GetQueryExecution until the StateChangeReason says why, and reads VarCharValue
 * cells page by NextToken.
 */
import { ATHENA_DISPLAY_NAME, AthenaTransportError } from "./transport";
import type { AthenaTransport } from "./transport";

export async function readOne(transport: AthenaTransport, database: string) {
  try {
    const result = await transport.query("SELECT 1");
    const { rows, fieldNames, columnTypes, queryExecutionId, statementType, affectedRows, stats } = result;
    const tables = await transport.listTables(database, 10);
    const workgroup = await transport.describeWorkgroup();
    const history = await transport.listExecutions(20);
    await transport.cancel(queryExecutionId);
    return { rows, fieldNames, columnTypes, statementType, affectedRows, stats, tables, workgroup, history, ATHENA_DISPLAY_NAME };
  } catch (error) {
    if (error instanceof AthenaTransportError && error.category === "unknown-object") return [];
    return { message: error instanceof Error ? error.message : String(error) };
  }
}
`;

  const VIOLATING_SAMPLE = `
import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
export async function run(sql: string) {
  const client = new AthenaClient({ region: "us-east-1" });
  const started = await client.send(new StartQueryExecutionCommand({ QueryString: sql }));
  const id = started.QueryExecutionId;
  const cell = page.ResultSet.Rows[0].Data[0].VarCharValue;
  return { id, cell, next: page["NextToken"] };
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findSdkLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fails a file that speaks the SDK, once per line and token", () => {
    const leaks = findSdkLeaks("index.ts", VIOLATING_SAMPLE);

    expect(leaks.map((leak) => leak.token)).toEqual([
      "AthenaClient",
      "StartQueryExecutionCommand",
      "@aws-sdk/client-athena",
      "AthenaClient",
      "StartQueryExecutionCommand",
      "VarCharValue",
      "NextToken",
    ]);
    expect(leaks[2].line).toBe(2);
    expect(leaks[6].snippet).toBe('return { id, cell, next: page["NextToken"] };');
  });

  test.each<[string, string, string]>([
    ["the package in an import", 'import { x } from "@aws-sdk/client-athena";', "@aws-sdk/client-athena"],
    ["the client", "const c = new AthenaClient({});", "AthenaClient"],
    ["a command class", "await c.send(new GetQueryResultsCommand({}));", "GetQueryResultsCommand"],
    ["a wire member read by key", 'const t = page["NextToken"];', "NextToken"],
    ["a wire member read as a property", "const r = status.StateChangeReason;", "StateChangeReason"],
    ["the cell member", "const v = datum.VarCharValue;", "VarCharValue"],
    ["the idempotency token", "const token = input.ClientRequestToken;", "ClientRequestToken"],
    ["a statistics member", "const ms = stats.EngineExecutionTimeInMillis;", "EngineExecutionTimeInMillis"],
  ])("flags %s", (_label, source, token) => {
    const [leak, ...rest] = findSdkLeaks("index.ts", source);

    expect(rest).toEqual([]);
    expect(leak.token).toBe(token);
    expect(leak.line).toBe(1);
  });

  test.each([
    ["the neutral result's fields", "const { rows, fieldNames, columnTypes, queryExecutionId } = result;"],
    ["the neutral id spelled in a string", 'const key = "queryExecutionId";'],
    ["the neutral statistics", "const ms = result.stats.engineMs ?? result.stats.queuedMs;"],
    ["the neutral catalog shapes", "const { tables, truncated } = await transport.listTables(db, 10);"],
    ["the neutral catalog listing", "const databases = await transport.listDatabases();"],
    ["the provider's own error mapping", "throw this.mapAthenaError(error, sql);"],
    ["a category checked by name", 'if (error.category === "unknown-object") return [];'],
    ["the package named in a string that is not an import", 'const doc = "see @aws-sdk/client-athena";'],
    ["an ordinary word containing none of the vocabulary", "const nextPage = page + 1;"],
  ])("does not flag %s", (_label, source) => {
    expect(findSdkLeaks("index.ts", source)).toEqual([]);
  });

  test("reports nothing when the seam holds", () => {
    expect(violationReport([])).toBe("");
  });

  test("the failure report explains the rule and names the offending line", () => {
    const report = violationReport(findSdkLeaks("index.ts", "const t = page.NextToken;"));

    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("AthenaQueryResult");
    expect(report).toContain('index.ts:1 uses "NextToken" -> const t = page.NextToken;');
  });
});
