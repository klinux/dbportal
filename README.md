<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/lockup-dark.svg">
    <img src="public/brand/lockup.svg" alt="dbportal" width="270">
  </picture>
</p>

<p align="center">
  A shared database portal for SRE, DevOps and developers.<br>
  One deployment. One set of datasources. Every execution attributed to a person.
</p>

<p align="center">
  <a href="https://github.com/klinux/dbportal/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/klinux/dbportal/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-1F6FEB"></a>
</p>

---

One deployment, one set of datasources, single sign-on, and an audit trail of
**every** execution — so nobody needs a database password, a bastion host, or
Adminer, and every statement that reaches a database is attributable to a person.

> **Status: early.** dbportal is a snapshot of [LibreDB Studio](https://github.com/libredb/libredb-studio)
> 0.16.0 (MIT) with the packaging and distribution machinery removed. The editor,
> the 16 database drivers, SSO and the Helm chart work today; the governance layer
> described below is being built on top. See [NOTICE.md](NOTICE.md) for attribution.

## Why

Teams that run databases end up with the same shape of problem:

- **Production**: SRE/DevOps need to run operational tasks (kill sessions, vacuum,
  inspect, fix data) and each one has to be auditable.
- **Staging**: developers need real power — `DELETE`, `DROP`, dumps — without a
  shared password floating around in a chat.
- **Both**: datasources should be configured **once**, centrally, with the
  credentials injected from a secrets manager, never typed by a person.

Web IDEs solve the editor part. Access proxies solve the audit part. dbportal
aims to be the one thing you deploy that does both for the browser use case.

## What works today (inherited)

- Browser SQL IDE (Monaco) with schema explorer, ER diagrams, schema diff,
  EXPLAIN, monitoring dashboard and maintenance actions.
- 16 engines: PostgreSQL, MySQL, Oracle, SQL Server, SQLite, libSQL, DuckDB,
  MongoDB, Redis, Couchbase, ClickHouse, Druid, Elasticsearch, OpenSearch,
  Trino, Cassandra — plus wire-compatible relatives (MariaDB, TimescaleDB,
  CockroachDB, Valkey, ScyllaDB, …).
- OIDC single sign-on (Keycloak, Okta, Entra ID, Auth0, …) with role mapping
  from claims; local accounts with TOTP as the fallback.
- **Managed datasources** from a YAML file, with `${ENV}` credential injection
  and per-role visibility (`roles: ["admin"]`, `["*"]`). Credentials never
  reach the browser.
- SSL/TLS and SSH tunnels for every networked engine.
- Helm chart, Docker image, `docker compose`.

## What dbportal adds

Each of these is in place; [docs/CONTEXT.md](docs/CONTEXT.md) §4 records the
design and what was deliberately left out of each.

1. **Datasources are created by admins only, and shared.** Declared in a YAML
   file or in the admin page, stored server-side; the request path that
   accepted a client-supplied connection is closed.
2. **Server-side audit of every execution** — person, datasource, duration,
   outcome (and the statement under `AUDIT_INCLUDE_SQL`) — as structured log
   lines and in an append-only `audit_events` table the user cannot clear.
3. **`application_name` per person** on database sessions, so the database's
   own logs (pgAudit, `pg_stat_activity`) show who, not the shared role.
4. **Access rules per datasource** — `roles` (who may open) and `writeRoles`
   (who may write), with `group:<name>` principals from the identity provider;
   read-only sessions get a read-only pool where the engine has one.
5. **Ephemeral credentials** — `vault:db:<mount>/<role>` has HashiCorp Vault's
   database secrets engine issue a credential per person, with a lease;
   `vault:kv:…` reads a static secret.
6. **Approval flow** — `writeApproval: true` runs a write only inside a window
   a reviewer opened, with the reviewer on the audit line.
7. **Server-side data masking** — the rules run before the rows leave; a
   reveal is granted per role and audited.

Things deliberately **out of scope**: desktop apps, marketplace listings, npm
library packaging, and any AI agent work beyond what is already here.

## Quick start

```bash
cp .env.example .env          # set JWT_SECRET, ADMIN_PASSWORD at least
docker compose up -d          # http://localhost:3000
```

Or for development (PostgreSQL in Docker as both the dev database and the server store,
the app under `bun run dev`):

```bash
bun install
make env          # .env.local from the example; set JWT_SECRET and ADMIN_PASSWORD
make dev          # database up, app on http://localhost:3000 (Ctrl+C stops the app)
make stop         # app and database down
```

`make help` lists the rest (`dev-bg`, `db-reset`, `status`, `check`, `test`, `coverage`).

Kubernetes: see [charts/](charts/) and [docs/HELM_CHART.md](docs/HELM_CHART.md).
Managed datasources: [docs/SEED_CONNECTIONS.md](docs/SEED_CONNECTIONS.md).
SSO: [docs/OIDC.md](docs/OIDC.md).

## Development

```bash
make check          # lint + typecheck
make test           # the suite the way CI runs it
make coverage       # the 100% line-coverage gate
bun run lint        # oxlint + eslint
bun run typecheck
bun run test:unit   # fast, no databases needed
bun run test:ci     # full core + component suites (per-file isolation)
docker compose -f database-compose.yml up -d && bun run test:integration
```

## Brand

The mark, lockups and colour system live in [public/brand/](public/brand/) and are
specified in [docs/DESIGN.md](docs/DESIGN.md). The wordmark is always lowercase
IBM Plex Mono; the three status colours describe execution outcomes only.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
