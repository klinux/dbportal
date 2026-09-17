# Amazon Athena Provider

> Amazon Athena support for dbportal, reached through the AWS SDK (`@aws-sdk/client-athena`): a
> statement is submitted as a job, polled to a terminal state, and its rows are read page by page
> through the SDK's command classes; the catalog is read through the service's metadata API rather
> than with statements. This document is the single reference point for the Athena provider:
> design, architecture, usage, tests, and - stated plainly - what has not yet been measured against
> the live service. If you are reading the code, extending Athena support, or authoring a provider
> over a vendor SDK, start here.

| | |
|---|---|
| **Status** | Implemented. **Not yet verified against the live service** ([§13](#13-known-limitations--future-work)) |
| **Database type id** | `athena` |
| **Family** | SQL (`src/lib/db/providers/sql/athena/`) |
| **Driver** | `@aws-sdk/client-athena` - the official SDK, pure JavaScript, no native addon ([§3.1](#31-the-sdk-and-not-fetch-because-of-sigv4-and-the-credential-chain)) |
| **Query language** | `sql` (Trino's dialect: Athena engine version 3 is a Trino fork) |
| **Default port** | None. The connection names a **region**; the SDK derives the endpoint from it ([§4](#4-connection)) |
| **Connection pooling** | None - the SDK holds its own HTTP pool; each statement is one job |
| **Connection string** | Not supported. `jdbc:awsathena://…` is a JDBC URL the shared parser does not read |
| **EXPLAIN** | Off. The engine answers `EXPLAIN (FORMAT JSON)` in Trino's shape, but that has not been measured here ([§5.6](#56-explain-is-off-until-measured)) |
| **Writes** | Whatever the table format allows: `INSERT INTO` on a Hive table appends files, an Iceberg table takes `UPDATE` and `DELETE` too ([§5.5](#55-writes-belong-to-the-table-format)) |
| **Transactions** | Not exposed |
| **Maintenance** | `kill` only - a stop by query execution id ([§8](#8-maintenance)) |
| **Query cancellation** | Yes - `cancelQuery()` stops the job; abandoning a poll does **not** ([§3.4](#34-abandoning-a-poll-does-not-stop-the-job)) |
| **Verified against** | **Nothing live yet.** Every test in this provider replays hand-built payloads shaped by the SDK's own model types. [§13](#13-known-limitations--future-work) lists what a live pass has to settle |
| **Source** | [`src/lib/db/providers/sql/athena/`](../../src/lib/db/providers/sql/athena/) |
| **Tests** | [`tests/integration/db/athena-provider.test.ts`](../../tests/integration/db/athena-provider.test.ts) + [`tests/unit/db/athena/`](../../tests/unit/db/athena/) |

---

## 1. Overview

Athena is a **serverless query service**: there is no server to connect to, no process to report
an uptime for, and nothing this client can hold open. A connection names an AWS region, a
**workgroup** and an S3 prefix results are written to, and reaches the service with an access key
pair - or with no credential at all, in which case the SDK's own provider chain (environment, shared
config, an instance or task role, a web identity) is used. The catalog is the AWS Glue Data Catalog
of that account and region, which Athena calls `AwsDataCatalog`; the data is files in S3 that the
catalog's table definitions point at.

Four service facts shape almost everything below:

1. **A statement is a job.** Submission answers an id; the job is polled until it reaches
   `SUCCEEDED`, `FAILED` or `CANCELLED`; only then can rows be read, a page of a thousand at a
   time. Abandoning the poll does **not** stop the job ([§3.4](#34-abandoning-a-poll-does-not-stop-the-job)).
2. **Every statement is billed for the bytes it scans and writes its answer to S3.** The catalog
   is therefore read through the service's metadata API and never with `information_schema`
   statements, and one listing per database is cached briefly ([§3.2](#32-the-catalog-is-read-through-the-metadata-api-never-with-statements)).
3. **A DML result set starts with a header row** that repeats the column names as data; a DDL or
   utility answer does not ([§3.5](#35-a-dml-result-set-starts-with-a-header-row)).
4. **Every cell is text.** A `bigint`, a `double` and a `boolean` arrive as strings beside a column
   declaration naming the type ([§5.3](#53-value-encoding)).

### Concept mapping

| `DatabaseProvider` slot | Athena realisation | Mechanism |
|---|---|---|
| "Database" (the connection's `database` field) | One **Athena database** (a Glue database), pinned as the default for unqualified names | `QueryExecutionContext.Database` on every submission |
| Container level | The database. **One level**: the catalog is pinned by the connection and reached in SQL by a qualified name | `ListDatabases` |
| "Table" / "View" (the relation kinds) | A Glue table; a view is the one entry whose `TableType` is `VIRTUAL_VIEW` ([§6](#6-schema-introspection)) | `ListTableMetadata` |
| Columns | The catalog's data columns, then its partition keys, types spelled as the catalog spells them (`string`, `bigint`, `array<string>`) | `ListTableMetadata` / `GetTableMetadata` |
| Primary key / foreign keys / indexes | **Nothing.** Glue records none of the three | — ([§3.6](#36-no-keys-no-indexes)) |
| "Connection" (sessions panel) | A **statement in flight** in the workgroup; the service holds no session object | `ListQueryExecutions` + `BatchGetQueryExecution` |
| "Storage" | **Nothing** - the catalog publishes no per-database bytes through this API | — ([§7](#7-monitoring--health)) |
| Server version | The workgroup's engine version, e.g. `Athena engine version 3` | `GetWorkGroup` |
| Uptime | **`N/A`** - a serverless service has none | — |

---

## 2. Architecture

### 2.1 Where it sits

```
src/lib/db/providers/sql/athena/
├── index.ts          AthenaProvider extends SQLBaseProvider - lifecycle, capabilities, delegation
├── transport.ts      THE SEAM - neutral types + AthenaTransportError + the service constants. No I/O.
├── sdk-transport.ts  The only file that imports @aws-sdk/client-athena. The job loop lives here.
├── settings.ts       The connection record read once, every refusal the service would make later
├── objects.ts        The object surface's pure derivations: kinds, paths, counts, details
└── introspect.ts     The monitoring reads, over the seam
```

The same seam shape as `sql/trino/`, `sql/druid/` and `sql/clickhouse/`, with one structural
difference: the catalog is not read with SQL, so the seam carries `listDatabases`, `listTables`,
`describeTable`, `describeWorkgroup` and `listExecutions` as methods of their own. Provider logic
never names a command, a wire field or a pagination token:
[`tests/unit/db/athena/seam-guard.test.ts`](../../tests/unit/db/athena/seam-guard.test.ts) parses
every source in the directory and fails the build the moment the SDK's vocabulary appears outside
`sdk-transport.ts`.

### 2.2 Class hierarchy

```
DatabaseProvider (interface)
└── BaseDatabaseProvider
    └── SQLBaseProvider
        └── AthenaProvider
```

### 2.3 What `SQLBaseProvider` gives for free

Double-quoted identifiers are correct in Athena's DML and `information_schema` is spelled the ANSI
way, so `escapeIdentifier()`, `isReadOnlyQuery()` and `isSchemaModifyingQuery()` are inherited
unchanged. `prepareQuery()` is overridden for the one clause-order trap the engine shares with Trino
([§3.7](#37-offset-comes-before-limit)).

### 2.4 Registration & lifecycle

`createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)) constructs the provider
for `type: "athena"`. The constructor runs `validate()`, which reads every setting off the record
through `readAthenaSettings()` ([`settings.ts`](../../src/lib/db/providers/sql/athena/settings.ts))
and refuses, as a `DatabaseConfigError` naming the field, everything the service would refuse later
with a worse sentence ([§4.2](#42-what-is-refused-before-a-request-is-made)).

`connect()` constructs an `AthenaSdkTransport` and **describes the workgroup**: one call that costs
no job, fails fast on a wrong region, a wrong key, a missing workgroup and an unreachable endpoint,
and whose answer settles two things a first statement would otherwise fail on - a disabled workgroup,
and a connection with nowhere to write results ([§4.3](#43-the-result-location)). Denied by
POLICY (`AccessDeniedException`, as opposed to a refused signature), the probe falls back to
`SELECT 1`, because a query-only IAM policy may withhold `athena:GetWorkGroup` while granting
`athena:StartQueryExecution`, and refusing such a connection would refuse one that runs every
statement the user came for. `disconnect()` releases the SDK's pool and forgets every recorded job
id and every cached listing.

---

## 3. Design decisions

### 3.1 The SDK, and not `fetch`, because of SigV4 and the credential chain

Every other HTTP provider in this repo reaches its engine with the runtime's own `fetch`, and
[`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) names SigV4 as the point where that promise
ends. A request to this service is signed with a four-step HMAC chain over a canonical request; a
signing routine written here would be a second implementation of something the SDK already gets
right, retries correctly (throttles and transient faults, with exponential backoff, four attempts),
and - the deciding argument - **resolves credentials for**. A connection carrying no key pair is
served by the SDK's provider chain, which is exactly how a deployment with a role available should
reach the service, and nothing written here could offer that.

The cost is stated: the package adds about 2 MB to the image across fourteen pure-JavaScript
packages, several of which the repo already carried through `@workflow/core`. There is no native
addon and no postinstall step.

### 3.2 The catalog is read through the metadata API, never with statements

`information_schema.tables` and `information_schema.columns` exist on Athena, and reading the tree
with them would be one job per read, each waited on and each written to S3 as a result object. The
tree asks four questions about a database in a row - count, list tables, list views, describe - so
a refresh would be four jobs. The service publishes the same catalog through `ListDatabases`,
`ListTableMetadata` and `GetTableMetadata`, which cost no execution, write nothing, and carry the
columns and partition keys in the listing itself, so a whole folder is described with no round trip
beyond the listing. `describeObjects()` reads the columns straight off that listing.

One listing per database is cached for thirty seconds inside the provider (`LISTING_TTL_MS`): long
enough to serve one refresh from one page walk, short enough that a table created in the console
appears on the next, and cleared outright when a statement the service classified as DDL runs
through this provider.

The listing has a **ceiling**, `OBJECT_LISTING_CEILING` (10,000 tables, two hundred pages of fifty).
A database past it is not silently cut: `countObjects()` carries every count as
`{ count, sampledFrom }`, the fourth `KindCount` state, so the tree badges the folder `10,000+`
rather than `10,000`, and `describeObjects()` reports the catalog's bound in its own sentence.

### 3.3 The job loop and its cadence

The transport polls `GetQueryExecution` after 200 ms, then each wait half again as long as the last,
capped at one second. A statement over Glue metadata finishes inside the first two reads; a
statement over a terabyte is asked about once a second, which is the cadence the service's own
console uses, and a long statement is billed for what it scans rather than for how often it is
asked about. The loop terminates on a **state** - `SUCCEEDED`, `FAILED` or `CANCELLED` - which is
the opposite of Trino's link-driven loop and the reason the two transports share no code. A runaway
guard (`MAX_POLLS`, two hours at the settled cadence) reports rather than silently accepts a job the
service never moves.

Every submission carries a fresh `ClientRequestToken` (a UUID), so a submission whose
acknowledgement was lost is answered by the SDK's own retry with the **same** job rather than
started twice and billed twice.

### 3.4 Abandoning a poll does not stop the job

A closed tab, an aborted request or an expired deadline leaves the statement running on the service
and scanning - and billing - to completion. So every exit path of a statement that is not a
completed answer stops the job explicitly with `StopQueryExecution`: an abort, a deadline, a
runaway poll, a failure raised while reading rows. The stop is best effort and never masks the
statement's own failure. On demand, `cancelQuery()` stops a statement by the CLIENT's token, having
learned the service's id while the statement was still in flight through the seam's
`onQueryStarted` hook, exactly as the Trino provider does.

The provider composes the deadline itself: every statement runs under
`AbortSignal.timeout(queryTimeout)`, the connection's query timeout. The shared default is sixty
seconds, which is short for a large scan; the connection's own `queryTimeout` raises it, and the
workgroup's `BytesScannedCutoffPerQuery` is the right place to bound the scan itself.

### 3.5 A DML result set starts with a header row

The first row of a `SELECT`'s first page repeats the column names as data; a DDL or utility answer
carries no such row. The transport drops it when three things hold at once: it is the first row of
the first page, the service classified the statement as `DML`, and every cell equals its column's
declared name. A data row further down that happens to repeat the names is never dropped, and a
`SHOW TABLES` whose first table is called `tab_name` keeps it. A `SELECT` that matched nothing
answers its header row and nothing else, and the grid sees zero rows.

### 3.6 No keys, no indexes

Glue records columns and partition keys and nothing else. There is no primary key, no foreign key
and no index object anywhere in the model, so `declaresForeignKeys` is `false`, `getIndexStats()`
answers `[]` without a call, and the inline row editor - which needs a primary key to build a
`WHERE` that identifies one row - is switched off rather than offered as a control that could only
rewrite every matching row. Every column is reported `nullable: true`, which is the catalog's own
answer (Athena's `information_schema.columns` says `YES` for every column of every table).

### 3.7 `OFFSET` comes before `LIMIT`

The shared limiter emits `LIMIT n OFFSET m` for every page after the first, and a Trino-family
grammar is `[ OFFSET count ] [ LIMIT count ]` and only that way round. The transposition lives in
[`offset-before-limit.ts`](../../src/lib/db/providers/sql/offset-before-limit.ts), shared with the
Trino provider that measured it; `prepareQuery()` applies it. A trailing `;` a caller wrote out of
habit is dropped by the transport for the same reason it is on Trino, through the span reader, so a
`;` inside a literal or a comment is never touched.

### 3.8 The connection's settings are refused here, not by the service

A typo in the region becomes a DNS failure for `athena.<typo>.amazonaws.com`, a temporary key
(`ASIA…`) without its session token becomes "The security token included in the request is
invalid", half a key pair becomes an invalid signature, and a result location without its trailing
slash fuses the query id onto the last path segment. Each is refused by `readAthenaSettings()`
before a request exists, naming the field and what would be accepted ([§4.2](#42-what-is-refused-before-a-request-is-made)).

### 3.9 Two parsers, two quotes

Athena reads DML with Trino's parser, where an identifier is double-quoted, and DDL with Hive's,
where a double-quoted name is a syntax error and the quote is the backtick. `identifierQuoting:
"double"` is therefore right for everything the query generators build, while the schema-diff
migration generator and the SQL-DDL export quote through `quoteDdlIdentifier()`
([`identifier.ts`](../../src/lib/sql/identifier.ts)), which answers backticks for this one
dialect and `quoteIdentifier()` for every other. The migration generator also spells `ADD COLUMNS
(...)` - parenthesised and plural, Hive's form - and refuses a column retype with the reason, because
a Hive table and an Iceberg table retype a column with different statements and the diff does not
record which format a table has.

### 3.10 Absent, never zeroed

`uptime` and `databaseSize` are the string `"N/A"`; `databaseSizeBytes` and `startTime` are not
written at all; `getPerformanceMetrics()` answers `{}`. Each absence is a different impossibility on
a serverless service - no process, no bytes it holds, no transactions, no buffer pool, no locks, no
cache ratio - and a zero in any of them would read as a measurement. `cacheHitRatio` in particular is
scored `direction: "below"` with `critical: 80`, so a "neutral" 0 would paint every healthy workgroup
red.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Meaning |
|---|---|---|
| `region` | **Yes** | The AWS region the service is called in (`us-east-1`). The whole address: the SDK derives the endpoint from it |
| `user` | No | The **access key id** of a long-term key pair (`AKIA…`). Both halves or neither |
| `password` | No | The **secret access key**. Both empty means the SDK's own credential chain - an instance or task role |
| `database` | No | The Athena database unqualified names resolve against, and the container the tree opens. A statement may still name any database in full |
| `workgroup` | No | Defaults to `primary`, which every account has. Carries the per-statement scan ceiling and, when it enforces its configuration, the result location |
| `outputLocation` | No | `s3://bucket/prefix/` - where every result is written. Needed unless the workgroup configures one; a missing trailing slash is added |
| `queryTimeout` | No | The deadline every statement runs under; the job is stopped when it fires. The shared default is 60 s |

No `host`, no `port`, no `ssl` and no `sshTunnel`: the SDK reaches the regional endpoint over TLS
on its own, and the connection form draws none of the four for this type. The form labels the two
credential boxes **Access Key ID** and **Secret Access Key**, so nobody types an IAM user name into
one.

### 4.2 What is refused before a request is made

| Setting | Refused | Why here |
|---|---|---|
| region | Absent, or not of the form `xx-word-1` | The SDK would resolve `athena.<typo>.amazonaws.com` and report a DNS failure |
| access key id | Starting with `ASIA` | A temporary key needs the session token it was issued with; the record has no field for one |
| key pair | One half without the other | Sent, it fails as an invalid signature, which points at the wrong half |
| workgroup | Outside `[a-zA-Z0-9._-]{1,128}` | The service's own constraint |
| result location | Not `s3://<bucket>/…` with a bucket name of 3-63 lowercase letters, digits, dots and hyphens | The service's answer would be a validation error about a parameter the user did not see |

### 4.3 The result location

Every statement writes its answer to S3 under either the location the connection names or the one
the workgroup configures; the service refuses a statement with neither. `connect()` therefore
refuses, as a configuration error, a connection that names no location against a workgroup that
configures none - at the form, rather than on the first statement. When the workgroup **enforces**
its configuration (`EnforceWorkGroupConfiguration`), the service ignores the location a statement
names and writes to the workgroup's; the seam carries that flag, and the object the result actually
landed in is on every statement's execution report (`stats.resultLocation`).

The bucket's own policy decides who may read what lands there. A result is the data the statement
returned, so the prefix deserves the same access rules as the data itself, and a lifecycle rule to
expire it.

### 4.4 IAM

A query-only principal needs `athena:StartQueryExecution`, `athena:GetQueryExecution`,
`athena:GetQueryResults` and `athena:StopQueryExecution`; `glue:GetDatabase`, `glue:GetDatabases`,
`glue:GetTable` and `glue:GetTables` for the tree (`athena:ListDatabases`, `athena:ListTableMetadata`
and `athena:GetTableMetadata` reach Glue through the service); `s3:GetObject`, `s3:PutObject` and
`s3:GetBucketLocation` on the result prefix; and `s3:GetObject` and `s3:ListBucket` on the data the
tables point at. The monitoring panels additionally read `athena:GetWorkGroup`,
`athena:ListQueryExecutions` and `athena:BatchGetQueryExecution`, and **degrade to nothing** when
those are withheld rather than failing the connection ([§7](#7-monitoring--health)).

The identity behind a statement is the IAM principal the connection uses; the person behind it is
this portal's audit trail, not the service's. CloudTrail records the principal, and the workgroup
records the statement.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` submits one statement, polls it to a terminal state and reads its
pages. Positional parameters are **refused** rather than interpolated: the service does bind them,
as execution parameters on the submission, but their quoting rules are the service's own and have
not been measured here; running the statement with its placeholders unbound, or splicing the values
into the SQL, are both worse than saying so.

### 5.2 Result shaping

`QueryResult.fields` is the declared column order; a duplicated output name (`SELECT 1 AS c, 2 AS c`)
is disambiguated `c`, `c (2)` while the row is rebuilt, because a row is a record and the second
column would otherwise vanish before the seam. `columnTypes` carries the service's rendered type per
column. `rowCount` is the rows returned, or - for a statement that returned none and changed
something - the count the service reported. `executionTime` is the service's own engine time when it
reported one.

### 5.3 Value encoding

Every cell arrives as text. The transport decodes the few types whose text form is lossless and
passes everything else through as the text the service rendered:

| Declared type | Decoded as |
|---|---|
| `tinyint`, `smallint`, `integer`, `bigint` | A number while it fits a double exactly; the text otherwise (a `bigint` past 2^53 stays exact) |
| `real`, `double`, `float` | A number when finite; `NaN` and the infinities stay the words the engine rendered |
| `boolean` | `true` / `false`; any other spelling stays text |
| everything else - `decimal`, `varchar`, `timestamp`, `date`, `array`, `map`, `row`, `json`, `varbinary` | The text, exactly as rendered |

A `decimal` stays text because parsing it into a double is the one place precision would be
destroyed silently. A `NULL` arrives as an absent cell and reaches the grid as `null`.

### 5.4 Dialect traps a user will hit

- **`OFFSET` before `LIMIT`**, and the limiter's page-two clause is transposed for you ([§3.7](#37-offset-comes-before-limit)).
- **A trailing `;` is not in the grammar.** One a caller wrote is dropped before submission.
- **DDL is Hive's grammar, with backticks.** `CREATE TABLE`, `ALTER TABLE` and `MSCK REPAIR TABLE`
  read a double-quoted name as a syntax error ([§3.9](#39-two-parsers-two-quotes)).
- **Every statement is billed.** Bound a scan with a partition predicate (`WHERE dt = '…'`) rather
  than with `LIMIT`, which bounds the output and not the bytes read.

### 5.5 Writes belong to the table format

`INSERT INTO` a Hive table appends files under its location; an Iceberg table takes `INSERT`,
`UPDATE`, `DELETE` and `MERGE`; a view takes nothing. No statement is special-cased here: the engine's
own refusal names the boundary better than anything this file could substitute. The `table` kind
declares `acceptsRowWrites`, the `view` kind does not.

### 5.6 EXPLAIN is off until measured

Athena engine version 3 answers `EXPLAIN (FORMAT JSON)` in Trino's plan shape, which the
`trino-json` strategy already renders. It is not enabled, because it has not been measured against
the service and a flag that is `true` without a strategy behind it is a dead button
([`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md), capability honesty). Enabling it is one
line in `getCapabilities()` once a live pass shows the JSON is the same shape - and it will be the
planning form only, never `EXPLAIN ANALYZE`, for the reason Trino's doc gives: the analyze form
executes the statement, and here every execution is a bill.

---

## 6. Schema introspection

### The object surface (#789)

**One container level**, `schema`, labelled *Database*: a Glue Data Catalog holds databases and a
database holds tables and views. `listContainers()` lists every database of the catalog and marks the
connection's own `isSessionDefault`; below the one level the answer is `[]`, because "nothing nests
under a database" is a fact about the engine and not a caller mistake.

**Two kinds**, `table` and `view`, and the reading of the catalog's `TableType` is the decision worth
recording. Glue's `TableType` is free text set by whoever registered the table: a crawler writes
`EXTERNAL_TABLE`, an Iceberg table is `EXTERNAL_TABLE` with a `table_type` parameter, a Lake
Formation governed table is `GOVERNED`, a CTAS answers `EXTERNAL_TABLE`, and a view created through
Athena is `VIRTUAL_VIEW`. Every spelling but the view's is a relation a statement can `SELECT` from,
so `kindOf()` ([`objects.ts`](../../src/lib/db/providers/sql/athena/objects.ts)) decides by the
**one spelling that means "not a table"** rather than by a list of the spellings that mean "table" -
a list would turn a spelling nobody here has seen into an object missing from the tree, which is the
defect shape standing ruling 5a (#789) names as the worst one. An entry with no recorded type is a
table.

`countObjects()`, `listObjects()` and `describeObjects()` all read one listing, so the count and the
listing agree by construction, and a listing the ceiling cut carries every count as a floor
([§3.2](#32-the-catalog-is-read-through-the-metadata-api-never-with-statements)).
`describeObject()` reads one entry with `GetTableMetadata` and checks the entry's own type against the
kind it was asked under: a table asked for as a view is a caller holding a stale tree, and answering
the columns anyway would let the tree draw one object under two folders. The partition keys are
listed after the data columns, in the catalog's order, which is the order `DESCRIBE` prints them
in; a statement addresses them exactly like a column.

---

## 7. Monitoring & health

The service publishes no process, no connection and no pool, so the panels are built from the one
record it does keep: the workgroup's recent execution history, read as `ListQueryExecutions`
(newest first, `ATHENA_HISTORY_WINDOW` of 200 ids) described in batches of fifty.

| Panel | Source | What it says |
|---|---|---|
| Overview | `GetWorkGroup` + the history + the pinned database's listing | Engine version; statements `QUEUED` or `RUNNING` as `activeConnections`; the table count; `uptime` and `databaseSize` `N/A` |
| Performance | — | `{}`: nothing is measured ([§3.10](#310-absent-never-zeroed)) |
| Slow queries | The history | `SUCCEEDED` statements ranked by **engine** time, `calls: 1` each (one row per execution), `rows: 0` because the service records no row count |
| Sessions | The history | Statements in flight, oldest first; `user` blank because the principal is a CloudTrail fact, `applicationName` the workgroup; the elapsed time measured against this clock, which the panel states rather than hides |
| Tables | The listing's own property bag | Row counts from `numRows` (an engine's) or `recordCount` (a crawler's), sizes from `totalSize` or `sizeKey`; a table with no count is left out, and a database where none has one is an ABSENT panel with the reason |
| Indexes | — | `[]`, no call: no index object exists |
| Storage | — | `[]`: the catalog publishes no per-database bytes through this API |

The workgroup description and the history are separately grantable, and losing one must not cost
the other: a withheld permission (`auth`) or a missing object (`unknown-object`) degrades that panel
to nothing, while a throttle or an unreachable endpoint propagates - hidden behind an empty panel it
would be hidden forever. The table statistics come through the same listing the tree reads, so a
refusal there propagates the way the tree's does.

---

## 8. Maintenance

One operation, `kill`, taking the query execution id the Sessions panel lists, and refusing anything
that is not a UUID rather than sending it. The service accepts a stop for a statement that has
already finished, so success here means "asked", not "stopped"; the statement's own record is what
reaches `CANCELLED`. Every other `MaintenanceType` is refused with the reason: the service owns no
storage to reclaim and computes no statistics of its own - the bytes are in S3 and the counts in the
catalog. `OPTIMIZE` and `VACUUM` exist for Iceberg tables only, in the editor; a control that fails
on every Hive table is worse than none.

### Where each operation may be offered (`maintenanceOperationSpecs`)

| Operation | Per entity | Global | Why |
|---|---|---|---|
| `kill` | no | no | Takes a query execution id, which is neither a table nor a whole database |

---

## 9. Capabilities & labels

### `getCapabilities()` ([`athena/index.ts`](../../src/lib/db/providers/sql/athena/index.ts))

| Capability | Value | Reason |
|---|---|---|
| `queryLanguage` | `sql` | Trino's dialect |
| `supportsExplain` | `false` | Not measured ([§5.6](#56-explain-is-off-until-measured)) |
| `supportsExternalQueryLimiting` | `true` | The shared limiter, with the transposition |
| `supportsCreateTable` | `false` | A Hive table needs `LOCATION`, an Iceberg table `TBLPROPERTIES`; the modal builds a bare column list |
| `supportsInlineRowEdit` | `false` | No key identifies one row ([§3.6](#36-no-keys-no-indexes)) |
| `supportsTransactions` | `false` | One job per statement |
| `declaresForeignKeys` | `false` | Glue records none |
| `supportsMaintenance` / `maintenanceOperations` | `true` / `["kill"]` | [§8](#8-maintenance) |
| `supportsConnectionString` | `false` | `jdbc:awsathena://` is a JDBC URL the parser does not read |
| `defaultPort` | `null` | No host, no port |
| `identifierQuoting` | `double` | DML is Trino's grammar ([§3.9](#39-two-parsers-two-quotes)) |
| `statementTerminator` | `none` | Not in the grammar; the generators emit none |
| `schemaRefreshPattern` | `CREATE`, `DROP`, `ALTER`, `MSCK` | A partition repair changes what the tree would show; an insert does not |
| `containerLevels` | `[{ id: "schema", label: "Database" }]` | [§6](#6-schema-introspection) |
| `objectKinds` | `table` (accepts row writes), `view` | [§6](#6-schema-introspection) |

### `getLabels()` ([`athena/index.ts`](../../src/lib/db/providers/sql/athena/index.ts))

Table and row are the engine's own words, so only the maintenance copy and the slow-query empty state
are rewritten: the inherited copy would promise a panel that updates planner statistics and reclaims
space, neither of which this service does, and would tell an operator to install a PostgreSQL
extension.

---

## 10. Error handling

Two sources feed `AthenaTransportError`, and the seam owes the distinction:

- **A statement the service ran and refused** reports its failure inside the job's status, with the
  engine's own fault name at the head of the sentence - `SYNTAX_ERROR: line 1:1: mismatched input
  'SELEKT'`, `TABLE_NOT_FOUND: line 1:15: Table 'awsdatacatalog.db.t' does not exist`. The name is
  the classifier and the vocabulary is Trino's (`SYNTAX_ERROR` → syntax; the five `*_NOT_FOUND` →
  unknown-object; `NOT_SUPPORTED` → unsupported; `PERMISSION_DENIED` → auth; `USER_CANCELED` →
  cancelled; `EXCEEDED_TIME_LIMIT` → timeout; `EXCEEDED_MEMORY_LIMIT`, `INSUFFICIENT_RESOURCES` →
  resources). An unlisted name arrives as text with the `engine` category; a fault the service itself
  marks retryable is `resources`. The sentence is carried verbatim, because it is the only text that
  locates the fault.
- **A request the service refused before it became a statement** arrives as an exception named by
  the service, and the name is the classifier: `AccessDeniedException`, `UnrecognizedClientException`,
  `InvalidSignatureException`, `ExpiredTokenException` and the SDK's own `CredentialsProviderError`
  → auth; `TooManyRequestsException`, `ThrottlingException` → resources; `ResourceNotFoundException`
  → unknown-object; any other service exception → engine with its message; an error that never
  reached the service (a refused socket, an unresolvable host) → unreachable.

The signal is consulted before the thrown value: an abort the caller asked for is reported as a
cancellation and a fired deadline as a timeout, whatever the SDK threw, because the signal is what
knows which happened. `mapAthenaError()` in the provider turns the category into the repo's error
classes - `auth` → `AuthenticationError`, `unreachable` → `ConnectionError`, `timeout` →
`TimeoutError` carrying the connection's timeout, `cancelled` → `QueryCancelledError`, everything
else → `QueryError` with the service's wording - and hands anything that is not a transport failure
to the shared mapping, because a bug in the provider is not a database error.

---

## 11. Testing

### 11.1 How the tests work

| File | Owns |
|---|---|
| [`tests/integration/db/athena-provider.test.ts`](../../tests/integration/db/athena-provider.test.ts) | The provider end to end over a scripted SDK client: metadata · validation · lifecycle · query · cancellation · error mapping · query preparation · the object surface (through the shared conformance guard) · monitoring · maintenance |
| [`tests/unit/db/athena/sdk-transport.test.ts`](../../tests/unit/db/athena/sdk-transport.test.ts) | The job loop and its backoff, the header-row rule, the cell decoding, the result paging and its ceiling, the stop on every exit path, the listings and their ceilings, every classification |
| [`tests/unit/db/athena/introspect.test.ts`](../../tests/unit/db/athena/introspect.test.ts) | Every monitoring read, against a hand-built runner, and what each panel says when its source is withheld |
| [`tests/unit/db/athena/objects.test.ts`](../../tests/unit/db/athena/objects.test.ts) | The object surface's pure derivations |
| [`tests/unit/db/athena/settings.test.ts`](../../tests/unit/db/athena/settings.test.ts) | Every refusal of [§4.2](#42-what-is-refused-before-a-request-is-made) |
| [`tests/unit/db/athena/transport.test.ts`](../../tests/unit/db/athena/transport.test.ts) | The seam's constants and error class |
| [`tests/unit/db/athena/seam-guard.test.ts`](../../tests/unit/db/athena/seam-guard.test.ts) | That the SDK's vocabulary appears nowhere but `sdk-transport.ts` |
| [`tests/helpers/athena-fake.ts`](../../tests/helpers/athena-fake.ts) | The scripted client both suites share |

**No `mock.module()` anywhere in this suite.** The client is handed to the transport, and to the
provider, through their own `deps`, which is what the seam exists for; the poll's wait is injected
the same way so the loop's shape is exercised without its cadence.

**No payload was captured from the live service.** Each is shaped by the SDK's own model types,
which the fake is typed against, so a field the model does not have does not compile - but a field
the model has and the service fills differently from what these tests assume would pass here and
fail live. The list of such assumptions is [§13](#13-known-limitations--future-work).

### 11.2 Run it

```bash
# Just this provider
bun test tests/unit/db/athena tests/integration/db/athena-provider.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.3 The live pass

There is no container fixture: Athena is a managed service with no image, and
[`database-compose.yml`](../../database-compose.yml) says so in a comment rather than leaving the
absence to be read as an oversight. A live pass needs an AWS account with a workgroup, a result
bucket and an IAM principal with the permissions of [§4.4](#44-iam); drive the provider through the
running application against it and record what [§13](#13-known-limitations--future-work) lists.

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```typescript
import { createDatabaseProvider } from "@/lib/db/factory";

const provider = await createDatabaseProvider({
  id: "lake",
  name: "Lake",
  type: "athena",
  region: "us-east-1",
  database: "analytics",
  workgroup: "reporting",
  outputLocation: "s3://lake-results/athena/",
  // Both empty: the instance or task role the server runs with.
  createdAt: new Date(),
});

await provider.connect();
const result = await provider.query('SELECT "dt", count(*) AS n FROM orders WHERE "dt" >= \'2026-09-01\' GROUP BY 1');
```

### 12.2 Seeded

```yaml
connections:
  - id: "lake"
    name: "Lake"
    type: athena
    region: us-east-1
    database: analytics
    workgroup: reporting
    outputLocation: "s3://lake-results/athena/"
    user: "${ATHENA_ACCESS_KEY_ID}"        # or leave both out for the runtime's role
    password: "${ATHENA_SECRET_ACCESS_KEY}"
    roles: ["*"]
    environment: production
```

---

## 13. Known limitations & future work

Everything here is either a decision or an unmeasured assumption, and the second kind is what a live
pass has to settle first:

- **Not verified against the live service.** The assumptions a live pass must confirm or correct:
  that a `SELECT`'s header row is present on the first page of every DML result and only there;
  that `StatementType` is `DML` for a `SELECT` and `UTILITY` for `SHOW`; that a failed job's
  `StateChangeReason` leads with the Trino fault name; that a missing table answers
  `GetTableMetadata` with a refusal the transport reads as absent rather than with
  `MetadataException`; that a view's `TableType` is `VIRTUAL_VIEW`; that `EXPLAIN (FORMAT JSON)`
  answers Trino's plan shape ([§5.6](#56-explain-is-off-until-measured)).
- **No EXPLAIN** until the above is measured.
- **No positional parameters** until the quoting of execution parameters is measured ([§5.1](#51-execution)).
- **No session token**, so no temporary credentials on the connection; a role in the runtime's
  environment is the way to use one ([§4.2](#42-what-is-refused-before-a-request-is-made)).
- **No federated catalog on the connection.** The catalog is `AwsDataCatalog`; a Lambda connector's
  catalog is reached by qualifying names in SQL.
- **No `CREATE TABLE` from the modal**, no keys, no indexes, no per-database storage - each a fact
  about the engine rather than a gap ([§3.6](#36-no-keys-no-indexes), [§7](#7-monitoring--health)).
- **The sessions panel measures elapsed time against this clock**, because the service reports a
  submission instant and no "now".
- **Agent auto/operate mode is out of scope.** `queryReadOnly()` is not implemented, so
  `acquireExecutionProfileProvider` fails closed for this type-id.

---

## 14. References

- Source: [`src/lib/db/providers/sql/athena/`](../../src/lib/db/providers/sql/athena/)
- The shared transposition: [`src/lib/db/providers/sql/offset-before-limit.ts`](../../src/lib/db/providers/sql/offset-before-limit.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/athena-provider.test.ts`](../../tests/integration/db/athena-provider.test.ts) · [`tests/unit/db/athena/`](../../tests/unit/db/athena/)
- The SDK: <https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/athena/>
- Athena engine version 3 (Trino-based) and its SQL reference: <https://docs.aws.amazon.com/athena/latest/ug/engine-versions-reference-0003.html>
- `EXPLAIN` on Athena: <https://docs.aws.amazon.com/athena/latest/ug/athena-explain-statement.html>
- Workgroups and result locations: <https://docs.aws.amazon.com/athena/latest/ug/workgroups-settings-override.html>
- Sibling provider docs: [Apache Trino](./trino.md) · [PostgreSQL](./postgres.md) · [ClickHouse](./clickhouse.md) · [Apache Druid](./druid.md)
