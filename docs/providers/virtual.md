# Virtual datasource

A virtual datasource (docs/CONTEXT.md §4.44) is a list of PostgreSQL and MySQL datasources
opened as one. There is no engine behind it: the provider
(`src/lib/db/providers/virtual/index.ts`) opens an embedded DuckDB session in memory,
attaches every member through DuckDB's `postgres` and `mysql` extensions, and runs the
person's statement there. The member is the catalog: `orders.public.pedidos`.

## The session

Per person and per virtual datasource, cached like any provider:

1. `:memory:` with `memory_limit = 512MB` and `threads = 4`.
2. `LOAD postgres` / `LOAD mysql`, from `DUCKDB_EXTENSION_DIR` (the image bakes them
   there; a developer's machine installs them into `~/.duckdb` on first use).
3. `ATTACH '<member>' AS "<member id>" (TYPE postgres|mysql, READ_ONLY)` for each member,
   with the credentials the person resolved for it (Vault, `${ENV}`), quoted the way
   libpq reads them for PostgreSQL and as bare pairs for MySQL (a MySQL value with a space or
   a quote is refused rather than attached under another name).
4. `SET enable_external_access = false` and `SET lock_configuration = true`.

Step 4 is the boundary, and it was measured on DuckDB 1.5.5 (`@duckdb/node-api`
1.5.5-r.4) before the provider was written. After it, in the same session:

| Statement | Answer |
|---|---|
| `ATTACH 'x.db' AS y` | `Permission Error: Cannot access file` |
| `ATTACH 'host=… dbname=postgres' AS z (TYPE postgres)` | `Permission Error: Attaching Postgres databases is disabled through configuration` |
| `INSTALL httpfs` / `LOAD httpfs` | `Permission Error` |
| `SELECT * FROM read_text('/etc/hostname')` | `Permission Error: file system operations are disabled` |
| `COPY (SELECT 1) TO '/tmp/x.csv'` | `Permission Error` |
| `SET enable_external_access = true`, `SET memory_limit = '100GB'` | `Cannot change configuration option` |
| `INSERT INTO crm.…` | `Cannot execute statement of type "INSERT" on database "crm" which is attached in read-only mode` |
| a read across the attached members | answers |

Two things the lock does not refuse on its own, and the provider refuses before the engine
sees them: `postgres_query(...)` / `mysql_query(...)` (raw SQL handed to a member) and DDL
in the session (`CREATE TABLE t AS …`, harmless but pointless). The provider also requires a
statement that reads (`isReadStatement`) and applies the DuckDB read-only profile's word list
(`ATTACH`, `INSTALL`, `LOAD`, `COPY`, `read_csv`, …). `SET`, `RESET`, `PRAGMA`, `USE`,
`CALL` and `DETACH` are refused too.

## The session's own process

The extensions and the remote attaches are native code inside libduckdb. A fault there is
a segfault, and a segfault in the studio would end every session and every request at
once - seen once, on the first fleet-health probe of a virtual datasource beside the other
embedded engines. So the session runs in a child process the provider spawns
(`runner.mjs`, plain JavaScript, spawned by path under bun in development and node in the
image; `DBPORTAL_VIRTUAL_RUNNER` names it, the image copies it to `/app/lib`). The child
speaks JSON lines over stdio: the bootstrap - loads, attaches with the credentials, the
lock - arrives on stdin, never on argv or in the environment; statements are answered in
order; an interrupt is answered out of band. A child that dies answers the statement in
flight and every later one with "the virtual session ended", the studio logs it with the
child's stderr, and the next open of that datasource starts a new one. `memory_limit` and
`threads` are the child's.

## What was measured

One million orders in PostgreSQL joined with two hundred thousand customers in MySQL, on a
laptop, both engines in Docker:

| Query | Time | Memory | Remote filter in the plan |
|---|---|---|---|
| join filtered to the last 7 days, top 100 | 170 ms | +22 MB | yes, on both scans |
| aggregate by city over 30 days | 131 ms | +12 MB | yes |
| one customer by id | 4 ms | +1 MB | yes (`id=4242` on the MySQL scan) |
| join with no filter, `count(*)` | 166 ms | +7 MB | no filter to push |

Extensions load in 24 ms; the two attaches take 9 MB. A statement interrupted from the
outside stops within the poll interval and the session stays usable.

## What it is not

Not a federated warehouse. Members are PostgreSQL and MySQL; joins of tens of millions of
rows, or other engines, belong to Trino as a datasource of its own (the driver exists).
Writes never; a virtual datasource's `writeRoles` is `[]` by construction.
