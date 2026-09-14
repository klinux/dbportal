# Seed Connections — Pre-Configured Database Connections

Seed Connections let administrators pre-configure database connections via a YAML or JSON file. Users see these connections immediately after login — no manual setup required.

**Use cases:**
- Platform/SaaS: provision databases for all users on signup
- Enterprise: give teams access to staging/production databases
- On-prem: DevOps pre-loads connections via Helm values or Docker volumes

## Quick Start

**1.** Create `seed-connections.yaml`:

```yaml
version: "1"

connections:
  - id: "prod-db"
    name: "Production Database"
    type: postgres
    host: "${DB_HOST}"
    port: 5432
    database: "${DB_NAME}"
    user: "${DB_USER}"
    password: "${DB_PASSWORD}"
    roles: ["*"]
```

**2.** Mount and set env vars:

```bash
docker run \
  -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e SEED_CONFIG_PATH=/app/config/seed-connections.yaml \
  -e DB_HOST=mydb.internal -e DB_NAME=mydb \
  -e DB_USER=reader -e DB_PASSWORD=secret \
  ghcr.io/klinux/dbportal:latest
```

**3.** Login — the connection appears in the sidebar with a lock icon.

---

## Config File Format

The config file is YAML (`.yaml`, `.yml`) or JSON (`.json`). Format is auto-detected by file extension.

```yaml
version: "1"

defaults:                    # Optional — merges managed/environment/ssl only
  managed: true
  environment: production
  ssl:
    mode: require
    rejectUnauthorized: true

connections:
  - id: "analytics-pg"       # Required, unique, lowercase slug [a-z0-9-]
    name: "Analytics DB"      # Required, display name in UI
    type: postgres            # Required: postgres|mysql|sqlite|libsql|duckdb|mongodb|redis|oracle|mssql|libredb|couchbase|clickhouse|druid|elasticsearch|opensearch|trino|cassandra
    host: "${PG_HOST}"
    port: 5432
    database: analytics
    user: "${PG_USER}"
    password: "${PG_PASSWORD}"
    environment: production   # production|staging|development|local|other
    group: "Data Team"        # Group label in sidebar
    color: "#10B981"          # Hex color for environment badge
    roles: ["admin"]          # Who can see this connection
    managed: true             # Read-only in UI (default from `defaults`)
    ssl:
      mode: require
      rejectUnauthorized: true
    # serviceName: "ORCL"     # Oracle only
    # instanceName: "MSSQL$"  # SQL Server only
    # localDataCenter: "datacenter1"  # Cassandra only - REQUIRED there
    # authSource: "admin"     # MongoDB only - the database the user was created in

  - id: "dev-mysql"
    name: "Dev MySQL"
    type: mysql
    host: "${MYSQL_HOST}"
    port: 3306
    database: devdb
    user: "${MYSQL_USER}"
    password: "${MYSQL_PASSWORD}"
    roles: ["*"]              # Everyone can see this
    managed: false            # User gets an editable copy
    environment: development

  - id: "events-druid"
    name: "Druid Events"
    type: druid
    host: "${DRUID_HOST}"
    port: 8888                # Router. The Broker's 8082 serves the same endpoint
    roles: ["*"]
    environment: production
    # No `database`: Druid reports exactly one catalog, always `druid`, so there is
    # nothing to select. No `connectionString` either - its HTTP SQL API has no URI
    # convention, so host and port are the whole address.
    # user/password are optional and only reach a cluster running druid-basic-security.

  - id: "lake-trino"
    name: "Trino Lakehouse"
    type: trino
    host: "${TRINO_HOST}"
    port: 8080                # The client protocol and the web UI share this port
    database: hive            # The CATALOG, not a database. Pins what the tree shows;
                              # a fully qualified name still reaches any other catalog.
    schema: default            # The session schema for unqualified table names. Without it,
                               # qualify names as schema.table in every statement.
    user: "${TRINO_USER}"
    roles: ["*"]
    environment: production
    # A `password` here would need `ssl.mode` set as well: the coordinator answers
    # 401 "Password not allowed for insecure authentication" over plain HTTP, even
    # with authentication switched off, so a password without TLS breaks a
    # connection that works without one.
    # No `connectionString`: jdbc:trino:// is not a form this build parses.

  - id: "events-ring"
    name: "Cassandra Ring"
    type: cassandra
    host: "${CASSANDRA_HOST}"
    port: 9042                     # The native protocol
    database: events               # The KEYSPACE, pinned for the session. Without it an
                                   # unqualified table name resolves to nothing.
    localDataCenter: datacenter1   # REQUIRED: the driver refuses to connect without it,
                                   # and a stock single-node install reports datacenter1.
    user: "${CASSANDRA_USER}"
    roles: ["*"]
    environment: production
    # No `connectionString`: no URI convention carries localDataCenter, so a pasted
    # one would produce a connection that cannot open.
```

### Field Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | Yes | — | Must be `"1"` |
| `defaults` | No | — | Supplies `managed`, `environment` and `ssl` where a connection omits them. No other field is merged |
| `defaults.managed` | No | `true` | Default managed state |
| `defaults.environment` | No | — | Default environment label |
| `defaults.ssl` | No | — | Default SSL config |
| `namedRoles` | No | — | Named roles (docs/CONTEXT.md §4.19): `{ id, name, members }`, referred to as `role:<id>` |
| `runbooks` | No | — | Runbooks (docs/CONTEXT.md §4.20): `{ id, name, description?, datasource, sql, params? }` |
| `connections` | Yes | — | Array of connection definitions (min 1) |
| `connections[].id` | Yes | — | Unique slug: `[a-z0-9-]+`, max 64 chars |
| `connections[].name` | Yes | — | Display name, max 128 chars |
| `connections[].type` | Yes | — | Database type: `postgres`, `mysql`, `sqlite`, `libsql`, `duckdb`, `mongodb`, `redis`, `oracle`, `mssql`, `libredb`, `couchbase`, `clickhouse`, `druid`, `elasticsearch`, `opensearch`, `trino`, `cassandra` |
| `connections[].host` | No | — | Hostname or IP |
| `connections[].port` | No | — | Port number (1-65535) |
| `connections[].database` | No | — | Database name (Couchbase: the bucket. Druid has one catalog and ignores it. Trino: the **catalog**) |
| `connections[].schema` | No | — | Trino session schema, used to resolve unqualified table names inside the configured catalog |
| `connections[].user` | No | — | Username |
| `connections[].password` | No | — | Password (use `${ENV_VAR}` syntax) |
| `connections[].connectionString` | No | — | Full connection string (use `${ENV_VAR}`). Druid and Trino have no URI form this build parses — those connections need `host` and are addressed by host and port only |
| `connections[].roles` | Yes | — | Who may open: `*`, `admin`, `user`, `group:<name>`, `role:<id>` |
| `connections[].exportRoles` | No | — | Who may export a result as a file (docs/CONTEXT.md §4.22); absent: everyone outside production, nobody on production |
| `connections[].managed` | No | from defaults | `true` = read-only, `false` = editable copy |
| `connections[].environment` | No | from defaults | Environment badge |
| `connections[].group` | No | — | Group label |
| `connections[].color` | No | — | Hex color for badge (e.g., `#10B981`) |
| `connections[].ssl` | No | from defaults | SSL configuration |
| `connections[].serviceName` | No | — | Oracle service name |
| `connections[].instanceName` | No | — | SQL Server instance name |
| `connections[].localDataCenter` | No¹ | — | Cassandra local data centre (`datacenter1`). ¹Optional in the schema because no other engine has it, and **required by the Cassandra provider**: the driver refuses to connect without one |
| `connections[].authSource` | No | — | MongoDB: the database its credentials live in (`admin` in the ordinary deployment). Without it the driver checks the user against the database being opened, which reports a credentials error |

---

## Credential Management

Credentials are never stored in the config file directly. Use `${ENV_VAR}` syntax to reference environment variables:

```yaml
connections:
  - id: "prod-db"
    password: "${PROD_DB_PASSWORD}"        # Resolved from process.env at runtime
    connectionString: "${MONGO_URI}"       # Also works for connection strings
    user: "${DB_USER}"                     # Any field can use ${} syntax
```

**How it works:**
1. Config file is read from disk (YAML/JSON)
2. `${VARIABLE_NAME}` patterns are resolved from `process.env`
3. If an env var is undefined, that connection is **skipped** (others continue working)

### Guardrails

Whatever the write rule says, a `DELETE` or `UPDATE` without `WHERE`, a `DROP` and a
`TRUNCATE` wait for a reviewer on `/admin/approvals` (docs/CONTEXT.md §4.15). A datasource
where that is unwanted - a scratch database - opts out:

```yaml
  - id: "scratch"
    type: postgres
    host: scratch.internal
    guardrails: false
```

### Ticket on every write

With `requireTicket: true` a datasource refuses a statement that writes unless the request
names a ticket or incident (docs/CONTEXT.md §4.18) - the studio's toolbar has a box for it,
and the bot API takes `ticket` - and the audit line carries it as `ticket`:

```yaml
  - id: "prod-orders"
    type: postgres
    host: orders.internal
    requireTicket: true
```

### Export by rule

Who may take a result out as a file (docs/CONTEXT.md §4.22). `exportRoles` uses the
principal vocabulary of `roles`; absent means everyone who can open the datasource may
export - except on production, where nothing leaves as a file until the list names who may;
`[]` is nobody. The file is built by the server, masked, bounded by `limits.maxRows` (or
100 000 rows), and every export is a `data_export` audit event.

```yaml
  - id: "prod-orders"
    type: postgres
    host: orders.internal
    environment: production
    exportRoles: ["group:analysts", "role:oncall"]
```

### Limits

What one statement may return, how long it may run, and how many a person may have
running at once on the datasource (docs/CONTEXT.md §4.16). Each is optional:

```yaml
  - id: "prod-orders"
    type: postgres
    host: orders.internal
    limits:
      maxRows: 1000          # a client may ask for fewer, never more; "unlimited" is capped here
      queryTimeoutMs: 30000  # the statement timeout the provider applies
      maxConcurrent: 2       # running statements per person; the next one is refused with 429
```

### Freeze windows

No statement that writes runs on the datasources a window names (or on any datasource when
it names none) between its two instants, whoever asks (docs/CONTEXT.md §4.17). Declared once
in the seed file, or on the admin page (Security → Freeze windows), where one is ended early
by deleting it:

```yaml
freezeWindows:
  - id: "release-42"
    reason: "Release 42 deploy"
    from: "2026-09-20T22:00:00Z"
    until: "2026-09-21T02:00:00Z"
    datasources: ["prod-orders", "prod-billing"]   # omit to freeze every datasource
```

### SSH profiles

A bastion is declared once and referenced by name (docs/CONTEXT.md §4.9); the server builds
the tunnel when a datasource that names it is opened, so no datasource carries a key:

```yaml
sshProfiles:
  - id: "prod-bastion"
    name: "Production bastion"
    host: bastion.internal
    port: 22
    username: portal
    authMethod: privateKey            # or password
    privateKey: "${BASTION_KEY}"      # a value, ${ENV_VAR}, or vault:kv:<mount>/<path>#<key>
    passphrase: "${BASTION_KEY_PASS}"
    hostKeyFingerprint: "SHA256:…"    # optional; pins the bastion's host key
connections:
  - id: "prod-orders"
    type: postgres
    host: orders.internal
    sshProfile: "prod-bastion"
```

Profiles may also be declared on the admin page (Security → SSH profiles), where they are
stored in the server store with the password, key and passphrase sealed at rest like a
datasource's own credentials. A profile named by any datasource cannot be deleted; one the
seed file declares is read-only there. A datasource that names an unknown profile, or a
profile whose `${ENV_VAR}` is unset, is refused with a 400 that says so.

### Vault references

A credential can also live in HashiCorp Vault and be fetched when the datasource is
opened (docs/CONTEXT.md §4.5). Two shapes, in the same fields `${ENV_VAR}` may occupy:

```yaml
connections:
  - id: "orders"
    type: postgres
    host: orders.internal
    password: "vault:db:database/orders"           # the database secrets engine ISSUES it
  - id: "reports"
    type: postgres
    host: reports.internal
    user: "vault:kv:secret/db/reports#user"         # one field of a KV v2 secret
    password: "vault:kv:secret/db/reports#password"
```

- `vault:kv:<mount>/<path>#<key>` reads `GET /v1/<mount>/data/<path>` once and keeps the
  secret for `VAULT_KV_TTL_MS` (default five minutes). The mount is the first path segment.
- `vault:db:<mount>/<role>` asks `GET /v1/<mount>/creds/<role>` for a credential with a
  lease. Valid in `password` only; it fills `user` too. One credential is issued **per
  person** who opens the datasource, so the database's own log names a user that belongs
  to one person, and it is re-issued at 80% of the lease so a pool never holds a user Vault
  is about to revoke. Each issue is an audited `credential_issued` event.

The server talks to Vault with `VAULT_ADDR` and `VAULT_TOKEN` (or `VAULT_TOKEN_FILE`, what
the Kubernetes injector and Vault Agent leave behind - re-read on every call), optionally
`VAULT_NAMESPACE`, with a `VAULT_TIMEOUT_MS` (default 5 s) on every request. A reference
the server cannot resolve refuses that request with a 503 that names the datasource and
never what Vault said (that goes to the server log); a malformed reference is a 400.
References pass the seed loader untouched, so a datasource with one is listed even while
Vault is down.
4. Plaintext passwords trigger a warning log (but still work)

**Resolvable fields:** `password`, `connectionString`, `user`, `host`, `database`

### Credential Sources by Deployment

| Deployment | How to provide credentials |
|------------|---------------------------|
| **Docker** | `-e DB_PASSWORD=secret` |
| **Docker Compose** | `environment:` block or `.env` file |
| **Kubernetes** | `Secret` → `extraEnvFrom` in Helm values |
| **Vault/SSM** | External Secrets Operator → K8s Secret → `extraEnvFrom` |

### Kubernetes Example

```yaml
# Create a K8s Secret with credentials
apiVersion: v1
kind: Secret
metadata:
  name: seed-db-credentials
type: Opaque
stringData:
  PG_PASSWORD: "my-secret-password"
  MYSQL_PASSWORD: "another-secret"

---
# Reference in Helm values
extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

---

## Role-Based Access Control

Each connection has a `roles` field that controls which users can see it:

| Config | Who sees it |
|--------|-------------|
| `roles: ["*"]` | All authenticated users |
| `roles: ["admin"]` | Admin users only |
| `roles: ["user"]` | Regular users only |
| `roles: ["admin", "user"]` | Both (same as `["*"]`) |

Roles are matched against the JWT session's `role` field. The role is extracted server-side from the JWT token — never from client input.

Beyond the two portal roles, a list may name a group the identity provider sends
(`group:<name>`) or a named role declared once (`role:<id>`, below).

### How Role Filtering Works

```
User logs in → JWT contains { role: "user" }
                    ↓
GET /api/connections/managed
                    ↓
Server reads config → filters by role
                    ↓
User sees only connections where roles includes "user" or "*"
```

---

## Who May Open, Who May Write

Two lists on every datasource, one vocabulary (docs/CONTEXT.md §4.4):

- `roles` — who may **open** it. Each entry is a principal: `*` (everyone signed in),
  `admin`, `user`, or `group:<name>` for a group the identity provider puts in the token
  (`OIDC_GROUPS_CLAIM`, default `groups`; local accounts have no groups).
- `writeRoles` — who may **write**. Absent: everyone who can open it. `[]`: nobody, the
  datasource is read-only for every session, administrators included (the portal's admin
  role is about the portal, not the database). Otherwise the same vocabulary.

```yaml
  - id: "prod-orders"
    name: "Orders (production)"
    type: postgres
    host: orders.internal
    password: "${ORDERS_PASS}"
    roles: ["group:sre", "group:support"]
    writeRoles: ["group:sre"]
```

A session that may not write sees the datasource with a read-only badge and may run only
statements that read: `SELECT` (and a read-only `WITH`), `SHOW`, `DESCRIBE`, and an
`EXPLAIN` of one of those — `EXPLAIN ANALYZE UPDATE …` runs the update and is refused.
Anything else is refused with a 403 and an audited `permission_denied` /
`read_only_datasource`. The whole of a multi-statement script is judged before any of it
runs, and every maintenance operation counts as a write. On an engine whose statements are
not SQL text (MongoDB, Redis, the search engines) a read-only rule refuses every
execution: a rule that cannot be enforced is not reported as enforced.

### Writes that need a reviewer

```yaml
  - id: "prod-orders"
    name: "Orders (production)"
    type: postgres
    host: orders.internal
    password: "${ORDERS_PASS}"
    roles: ["group:support"]
    writeApproval: true
    approverRoles: ["group:dba"]     # administrators when absent
```

With `writeApproval: true`, a statement that writes runs only inside an open **write
window**: an approval a reviewer granted to that person, on that datasource, for a bounded
number of minutes (docs/CONTEXT.md §4.6). Without one the statement does not run - it
becomes a pending request (one per person and datasource, carrying the statement) and the
response is a 403 with `code: "APPROVAL_REQUIRED"` and the request; the editor shows the
waiting state and polls until a reviewer decides. Reviewers are the datasource's
`approverRoles` (same vocabulary as `roles`) or administrators, on the admin page's
Approvals section or through `GET/POST /api/approvals`. Nobody reviews their own request.
Every execution inside a window carries `approval_id` and `reviewer` on its audit line; the
decision itself is an `approval_decision` event. Approval needs server storage
(`STORAGE_PROVIDER=sqlite|postgres`); without it, writes on such a datasource are refused
with a 503 that says so, and reads are unaffected.

This is a policy gate on the statement's text. Where the engine can enforce read-only
itself, the session's pool is opened that way too — PostgreSQL gets
`default_transaction_read_only=on`, so a `SELECT` that calls a writing function is refused
by the database, not by the classifier.

### Named roles

A role declared once (docs/CONTEXT.md §4.19), with who is in it, that every list above
refers to as `role:<id>`: a reviewer who does not administer, an on-call who may write,
named in one place instead of a group repeated on every datasource. Members are a portal
role (`admin`, `user`), a group from the identity provider (`group:<name>`), or one person
by the username the session carries (`user:<username>`) - never another role.

```yaml
namedRoles:
  - id: "oncall"
    name: "On-call"
    members: ["group:sre-oncall", "user:ana@example.test"]
  - id: "reviewer"
    name: "Reviewer"
    members: ["group:dba"]

connections:
  - id: "prod-orders"
    type: postgres
    host: orders.internal
    roles: ["group:support", "role:oncall"]
    writeRoles: ["role:oncall"]
    writeApproval: true
    approverRoles: ["role:reviewer"]
```

Administrators declare more on the Security page's Roles tab (server storage needed; a
seed-file role is read-only there and shadows a stored one with the same id). A session's
roles are resolved on every request from a list cached five seconds, never written into
the token: a change applies at once. Reviewers who do not administer find the requests on
`/approvals`, in the studio's user menu.

### Runbooks

A statement declared once for one datasource (docs/CONTEXT.md §4.20), with the values it
asks for named as `{{name}}`: the incident lookup, the routine fix, the report. Anyone who
may open the datasource finds it on the studio's Runbooks tab, fills in the form and runs
it; the values are bound by the driver, never written into the statement, and the audit
line names the runbook. A runbook grants no right its runner lacks by hand.

```yaml
runbooks:
  - id: "customer-orders"
    name: "Open orders of a customer"
    description: "What a customer is waiting for"
    datasource: "prod-orders"
    sql: "SELECT * FROM orders WHERE customer_id = {{customer_id}} AND status = {{status}} LIMIT {{limit}}"
    params:
      - { name: customer_id, type: number, label: "Customer id" }
      - { name: status, type: string, default: "open" }
      - { name: limit, type: number, required: false }
```

`type` is `string`, `number` or `boolean`; a parameter is required unless `required: false`
or it has a `default`. Every `{{placeholder}}` must be a declared parameter. Administrators
declare more on the Operations page (server storage needed; a seed-file runbook is
read-only there). Engines without bound parameters (Redis, MongoDB, the search engines,
Cassandra) refuse a runbook that has parameters.

## Every Connection Is Managed

Every datasource — seed file, runtime store, built-in sample — is opened by its seed id and
never leaves the server as a whole connection:

- It appears with a **lock icon** in the sidebar; nobody edits, duplicates or deletes it there.
  An administrator changes it under Admin → Datasources (runtime) or in this file (GitOps).
- Credentials are **never sent to the client** — the server resolves them at query time, so a
  password rotation reaches every user on their next request.
- If an administrator removes it, it disappears for everyone.

`managed: false` is still accepted by the schema for compatibility with older files, but it
no longer does anything: the browser cannot hold a copy of a connection any more
(docs/CONTEXT.md §4.1), so the entry is served like any other. The `dismissed_seeds`
per-user collection that tracked deleted copies is kept in storage for the same reason and
is not read.

---

## Runtime Datasources (admin UI)

The seed file is the GitOps way to declare a shared datasource. The runtime way is the
**Datasources** section of the admin dashboard (`/admin/datasources`), backed by
`GET/POST /api/admin/datasources` and `PUT/DELETE /api/admin/datasources/[id]`. Both kinds
end up in the same list every user sees, opened by the same `seed:<id>` handle, and filtered
by the same `roles`.

- A runtime datasource is validated by the same schema as a seed entry and may reference a
  secret the server holds with `${ENV_VAR}`, exactly like the file. The admin dialog tests
  the connection before saving, and the server resolves the reference during that test, so
  the value never travels through the browser.
- Records are persisted server-side, encrypted like every stored connection, under a
  reserved owner in `user_storage`. This needs `STORAGE_PROVIDER=sqlite` or `postgres`; on
  `local` the page explains what to set and the API answers 503, while the seed file keeps
  working.
- The seed file wins an id collision, and the API refuses to create a runtime datasource
  with an id the file declares. Seed-file datasources are listed on the page read-only.
- The page groups datasources by **environment** (`production`, `staging`, `development`,
  `local`, `other`) — set it on each entry, or once under `defaults`.
- Every create, update and delete is an audit event (`managed_connection`) naming the
  administrator and the datasource, never a credential.

## Hot Reload

The config file is **cached in memory** with a TTL (default 60 seconds). When the file changes:

1. Next API request after TTL expires triggers a re-read
2. New connections appear, removed connections disappear
3. Updated credentials take effect immediately (for `managed: true`)
4. **No restart required**

### Tuning the Cache TTL

```bash
# Default: 60 seconds
SEED_CACHE_TTL_MS=60000

# Faster refresh (5 seconds) — useful during development
SEED_CACHE_TTL_MS=5000

# Slower refresh (5 minutes) — production with infrequent changes
SEED_CACHE_TTL_MS=300000
```

In Kubernetes, ConfigMap updates propagate in ~60-120s (kubelet sync period). Combined with the cache TTL, expect ~2-3 minutes for changes to take effect.

---

## Deployment Examples

### Docker

```bash
docker run \
  -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e SEED_CONFIG_PATH=/app/config/seed-connections.yaml \
  -e PG_PASSWORD=secret \
  -e JWT_SECRET=your-32-char-jwt-secret-here!! \
  -e ADMIN_PASSWORD=MyAdmin123 \
  -e USER_PASSWORD=MyUser123 \
  -p 3000:3000 \
  ghcr.io/klinux/dbportal:latest
```

### Docker Compose

```yaml
services:
  libredb:
    image: ghcr.io/klinux/dbportal:latest
    ports:
      - "3000:3000"
    volumes:
      - ./seed-connections.yaml:/app/config/seed-connections.yaml:ro
    environment:
      SEED_CONFIG_PATH: /app/config/seed-connections.yaml
      JWT_SECRET: your-32-char-jwt-secret-here!!
      ADMIN_PASSWORD: MyAdmin123
      USER_PASSWORD: MyUser123
      PG_PASSWORD: ${PG_PASSWORD}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    env_file:
      - .env  # Store credentials here
```

### Kubernetes (Helm)

**Option A — Inline config in values.yaml:**

```yaml
seedConnections:
  enabled: true
  config:
    version: "1"
    defaults:
      managed: true
      environment: production
    connections:
      - id: "prod-analytics"
        name: "Production Analytics"
        type: postgres
        host: analytics-db.internal
        port: 5432
        database: analytics
        user: readonly
        password: "${ANALYTICS_DB_PASSWORD}"
        roles: ["admin"]
        color: "#10B981"
      - id: "staging-api"
        name: "Staging API DB"
        type: mysql
        host: staging-mysql.internal
        password: "${STAGING_DB_PASSWORD}"
        roles: ["*"]
        managed: false
        environment: staging

extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

**Option B — External ConfigMap:**

```yaml
seedConnections:
  enabled: true
  existingConfigMap: "my-seed-connections"  # Pre-created ConfigMap
  configMapKey: "connections.yaml"          # Key within the ConfigMap

extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Config file not found | App runs normally, no seed connections. Warning logged. |
| Invalid YAML/JSON | Endpoint returns 500. Error logged with details. |
| Invalid config (Zod validation fails) | Endpoint returns a generic 500. Validation errors are logged server-side, not returned in the response body. |
| Unrecognized `version` | Endpoint returns 500. Future versions require code update. |
| `${ENV_VAR}` not defined | That connection is **skipped**. Others work normally. Error logged. |
| User role doesn't match any connection | Empty list returned. Normal behavior. |
| Seed connection not found at query time | 404 response. |
| User doesn't have access to seed connection | 403 response. |

**Design principle:** One broken connection never breaks the others. Each connection is resolved independently.

---

## Security Model

### Credential Protection

- `managed: true` connections: passwords **never reach the client**. The API strips `password` and `connectionString` from responses. Server resolves credentials at query execution time.
- Config file should be mounted **read-only** (`:ro` in Docker, `readOnly: true` in Kubernetes).
- Use `${ENV_VAR}` for all secrets. Plaintext passwords trigger a warning log.

### Role Enforcement

- User role is extracted from the JWT session **server-side** — never from client headers or request params.
- Every database operation (query, schema, health check, etc.) goes through `resolveConnection()` which verifies role access before returning credentials.
- Role check failures return 403 with no credential information.

### Audit Trail

`resolveConnection()` (`src/lib/seed/resolve-connection.ts`) logs every seed-connection lookup through the structured logger:

- A successful resolution logs at `debug` level with `route`, `connectionId`, and `user`.
- A denied lookup (connection exists but the caller's role isn't in `roles`) logs at `warn` level with `route`, `connectionId`, `user`, and `role`, before the 403 is returned.

This is the standard application logger (`src/lib/logger.ts`), not a persisted audit-log entry — there is currently no dedicated `managed_connection` audit-ring-buffer event wired up for seed connections, despite that event type existing in `src/lib/audit.ts`'s `AuditEventType` union.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEED_CONFIG_PATH` | `/app/config/seed-connections.yaml` | Path to config file |
| `SEED_CACHE_TTL_MS` | `60000` | Cache TTL in milliseconds |

These are unrelated to the embedded sample connection described below, which uses its own `DBPORTAL_EMBEDDED_SAMPLE` / `DBPORTAL_EMBEDDED_SAMPLE_PATH` variables.

---

## Built-in Sample Connections

Every deployment also gets automatic, code-defined sample connections:

- **Sample (LibreDB)** — on first startup, `src/lib/seed/libredb-sample.ts` creates an embedded LibreDB file (default `<data dir>/sample.libredb`, alongside the SQLite storage DB) and seeds it with example data — a `users` table, an `articles` document collection, and a couple of KV entries — one per LibreDB lens. Seeded synchronously during boot.
- **Sample (Employees)** — `src/lib/seed/sqlite-sample.ts` copies the vendored employees SQLite database (`seed-assets/sqlite/employee.db`, from [bytebase/employee-sample-database](https://github.com/bytebase/employee-sample-database) `dataset_small`, originally [datacharmer/test_db](https://github.com/datacharmer/test_db); see `seed-assets/sqlite/ATTRIBUTION.md`) to `<data dir>/sample-employees.db`. Seeded **asynchronously and fail-open**: boot never waits for the copy; while it is in flight `GET /api/connections/managed` lists the seed id in `pendingSeeds` and the client polls (1s, max 30 attempts; the interval constant is inlined at build time — `NEXT_PUBLIC_MANAGED_POLL_MS` only affects source builds and tests, not packaged artifacts) so the connection appears without a page refresh.

`getManagedConnections()` appends each sample to the managed-connections list once its file exists (`managed: true`, `roles: ["*"]`), so it behaves like any other seed: opened by its seed id, read-only in the studio, and gone for everyone once the variable below disables it. A portal deployment that wants no demo data sets both variables to `false`.

This is separate from the `SEED_CONFIG_PATH` file and needs no config of its own:

| Variable | Default | Description |
|----------|---------|-------------|
| `DBPORTAL_EMBEDDED_SAMPLE` | `true` | Set to `false` (exact match) to disable the LibreDB sample |
| `DBPORTAL_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample.libredb` | Override the LibreDB sample file's location |
| `SQLITE_EMBEDDED_SAMPLE` | `true` | Set to `false` (exact match) to disable the SQLite sample |
| `SQLITE_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample-employees.db` | Override the SQLite sample file's location |
| `SQLITE_EMBEDDED_SAMPLE_TEMPLATE` | `<cwd>/seed-assets/sqlite/employee.db` | Override the vendored template's location |

The sample files are only created if they don't already exist — the seeding is idempotent and never overwrites a user's edits.

---

## Troubleshooting

### Connections don't appear after login

1. Check if the config file exists at `SEED_CONFIG_PATH`
2. Check server logs for `Seed config file not found` warning
3. Verify the YAML is valid: `cat seed-connections.yaml | python3 -c "import yaml,sys; yaml.safe_load(sys.stdin)"`
4. Check if `${ENV_VAR}` values are set: connections with unresolvable vars are silently skipped

### "Access denied" error when querying

The user's role doesn't match the connection's `roles` array. Check:
- User JWT role: login as admin vs user
- Connection `roles` field in config

### Credentials not updating after config change

Wait for the TTL to expire (default 60s), or restart the app. Every connection resolves its
credentials on the server, so nothing has to be cleared in a browser.

### A connection from an older version is still listed, and every query answers 400

Before docs/CONTEXT.md §4.1 the browser could hold connections of its own; the studio no
longer reads them, so a row that still shows up comes from a stale `libredb_connections`
entry in localStorage. Clear that key and refresh — the list is the server's answer alone.

---

## Architecture

```
seed-connections.yaml (volume mount)
        │
  ┌─────▼──────────┐
  │  ConfigLoader   │  Read + YAML/JSON parse + Zod validate + TTL cache
  └─────┬──────────┘
        │
  ┌─────▼──────────────┐
  │ CredentialResolver  │  ${ENV_VAR} → process.env + plaintext warning
  └─────┬──────────────┘
        │
  ┌─────▼──────────────┐
  │ ConnectionFilter    │  Role filter + defaults merge → ManagedConnection[]
  └─────┬──────────────┘
        │         ┌───────────────────────────────────────┐
        ├─────────┤ Embedded samples (libredb-sample.ts,   │  Appended if enabled and the
        │         │ sqlite-sample.ts)                      │  sample file exists
        │         └───────────────────────────────────────┘
  ┌─────▼───────────────────────┐
  │ GET /api/connections/managed │  Auth + strip credentials for managed:true
  └─────┬───────────────────────┘
        │
  ┌─────▼────────────────────┐
  │ useConnectionManager     │  Merge managed + user connections
  └─────┬────────────────────┘
        │
  ┌─────▼────────────────────────────┐
  │ resolveConnection() (all routes) │  seed: prefix → server-side credential resolution
  └──────────────────────────────────┘
```

**Module:** `src/lib/seed/` (8 files, about 700 lines total)

| File | Responsibility |
|------|---------------|
| `types.ts` | Zod schemas + TypeScript types |
| `config-loader.ts` | File read + parse + validate + cache |
| `credential-resolver.ts` | `${ENV_VAR}` resolution |
| `connection-filter.ts` | Role filter + defaults merge |
| `resolve-connection.ts` | Shared utility for all API routes |
| `libredb-sample.ts` | Built-in "Sample (LibreDB)" connection: file seeding + descriptor |
| `sqlite-sample.ts` | Built-in "Sample (Employees)" connection: vendored template copy + descriptor |
| `index.ts` | Public API: `getManagedConnections()` |
