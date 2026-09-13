# Project context — read this first

This file carries the reasoning behind dbportal so that anyone (or any tool) picking up
the repo can continue without the original conversation. Keep it current: when a decision
here changes, edit it in the same PR.

## 1. Where dbportal came from, and why it is not a fork

dbportal is a **snapshot** of [LibreDB Studio](https://github.com/libredb/libredb-studio)
0.16.0, MIT, taken on 2026-09-12. Attribution is in [NOTICE.md](../NOTICE.md) and the
original copyright line is kept in [LICENSE](../LICENSE). It is not a fork and does not
track upstream.

Findings from the evaluation that led to the snapshot:

- Upstream is a one-person project (≈77 % of commits by one maintainer, 121 releases in
  nine months, still 0.x). Its governance layer ("LibreDB Platform") is a closed beta with
  no public code and no roadmap. Waiting for it is not a plan.
- The parts we need are exactly the parts upstream does **not** have (see §3). The parts
  upstream has — the editor, the 16 drivers, OIDC, the Helm chart, 250k lines of tests —
  are the parts worth keeping. Forking and rebasing against weekly releases of a monolith
  would cost more than it returns; a snapshot with occasional cherry-picks of driver fixes
  is the right trade.

## 2. What the product is

A shared web portal for running database work, deployed once next to the databases:

- **Production** — SRE/DevOps run operational tasks (inspect, kill sessions, vacuum, fix
  data) and every statement is attributable to a person.
- **Staging** — developers get real power (`DELETE`, `DROP`, exports) without a shared
  password, and every statement is still recorded.
- **Both** — datasources are configured **once**, by an admin, with credentials injected
  from a secrets manager. Nobody types a database password; nobody creates their own
  connection.

It replaces Adminer-style tools and raw bastion/SSH access for the browser use case. It
does **not** replace database-side audit (pgAudit) or a wire-protocol proxy — both remain
recommended alongside it.

## 3. What the snapshot does *not* do yet (the gaps that define the roadmap)

Verified in code, not from the README:

| Gap | Where | What actually happens today |
|---|---|---|
| Anyone can create a connection | [`src/lib/seed/resolve-connection.ts`](../src/lib/seed/resolve-connection.ts) — `if (connection && !connectionId) return connection;` | Any authenticated user sends a full connection (host, user, password) in the request body and the server connects to it. 12 routes under `src/app/api/db/*` follow this path. Only `seed:` ids are server-controlled. |
| No server-side audit of human queries | [`src/app/api/db/query/route.ts`](../src/app/api/db/query/route.ts) and siblings `multi-query`, `transaction`, `maintenance` | The routes call the provider directly with no `emitAuditEvent`. Query history is written **client-side** (`use-query-execution.ts` → `storage.addToHistory`), capped at 500 per user, and the user can clear it. The admin "Audit" tab reads the admin's own history. |
| Audit channel excludes SQL by design | [`src/lib/audit.ts`](../src/lib/audit.ts) — "What must never be recorded here: … SQL text" | The stdout JSON channel records logins, denials, maintenance — never the statement. The in-memory ring buffer holds 1000 events per process. |
| Two-role RBAC | [`src/lib/auth.ts`](../src/lib/auth.ts) — `type Role = "admin" \| "user"` | Seed YAML supports `roles: ["admin"]` / `["*"]`. No groups, no per-datasource read/write matrix. |
| Static shared credentials | [`src/lib/db/factory.ts`](../src/lib/db/factory.ts) — provider cache keyed by connection | Every user shares the database role; the database's own logs cannot name the person. |
| Masking is client-side | [`src/lib/data-masking.ts`](../src/lib/data-masking.ts) | Column-name regex in the browser; `salary AS x` escapes it; the API returns raw values. |
| Only the AI agent path is policy-checked | [`src/lib/db/operations/execution.ts`](../src/lib/db/operations/execution.ts) — `executeAuditedOperation` | Policy → audit → budget → driver pipeline exists, but only for agent runs and only on PostgreSQL/SQLite/DuckDB. It is the best piece to generalise to the human editor path. |

## 4. Roadmap, in order, with the intended design

### 4.1 Datasources are created by admins only, and shared ← **next**

Two steps. The first closes the hole; the second delivers the product.

**Step A — close the client-supplied connection path (small, safe):**
- `resolveConnection`: when `body.connection` is present and the session role is not
  `admin`, throw `SeedConnectionError(403)`. Audit the denial with reason
  `insufficient_role` (the reason union already exists).
- UI: hide "New connection" and the connection dialog for non-admin sessions; keep the
  managed list.
- Tests: `tests/unit/seed/resolve-connection.test.ts` and the API tests under
  `tests/api/db/` already mock sessions — add the non-admin cases.

**Step B — server-side shared datasources:**
- Admin CRUD (`/api/admin/datasources`) persisted server-side, encrypted like the existing
  `connections` collection ([`src/lib/storage/encrypting-provider.ts`](../src/lib/storage/encrypting-provider.ts)),
  with `roles` like the seed YAML. The seed YAML stays as the GitOps way to declare them;
  the CRUD is the runtime way. Both feed `getManagedConnections()`.
- Non-admin users only ever send `connectionId`. The `connection` body field is removed
  from every `src/app/api/db/*` route once Step B lands.

### 4.2 Server-side audit of every execution

- In the four execution routes, after the provider call: `emitAuditEvent({ type:
  "query_execution", user, connectionName, sql, duration, result })`.
- SQL text behind an explicit env flag (`AUDIT_INCLUDE_SQL=true`) so the redaction rule in
  `audit.ts` stays the default; the flag is the operator's conscious choice.
- Persist to a store the user cannot reach (not the per-user `user_storage` blobs):
  stdout JSON lines to the log pipeline is the authoritative channel today; a dedicated
  append-only table in the `postgres` storage provider is the next step.
- The admin Audit tab reads that store, not the admin's own history.

### 4.3 `application_name` per user

On provider connect, set `application_name = "<username>@dbportal"` (PostgreSQL) or the
engine's equivalent, so `pg_stat_activity` and pgAudit show the person behind a shared
role. Cheap, and gives a second, independent audit trail.

### 4.4 Real RBAC → 4.5 Ephemeral credentials (Vault) → 4.6 Approval flow → 4.7 Server-side masking

Design notes for these live in [DESIGN.md](DESIGN.md) §"State Management" and
§"Interactions" (write window, awaiting-approval state, masked columns, audit rail).

## 5. Decisions already taken

- **TypeScript stays.** The 50k-line driver layer is the main asset; rewriting the backend
  in Go would throw it away to gain a static binary. If a Go component ever makes sense it
  is a wire-protocol proxy beside dbportal, not inside it.
- **UI and API will be separated** eventually (the Next.js monolith with API routes is the
  weakest structural point), but not before 4.1 and 4.2 ship.
- **Rebrand is a separate, deliberate pass.** ~2,600 `libredb`/`LibreDB` occurrences
  remain. Many are functional: storage keys (`libredb_*` collections, `libredb-storage.db`),
  env var names, the `libredb` engine type and its `@libredb/libredb` dependency, the chart
  name `charts/libredb-studio`. Do not mass-replace. Rename in layers, with tests.
- **Out of scope:** desktop apps, marketplace listings, npm library packaging, extending the
  AI agent.
- **No organisation names in this repository.** It is public and personal until adopted.

## 6. What was removed in the snapshot (so nobody goes looking for it)

`desktop/` (Tauri), `packaging/` (Snap, Flatpak, winget, Chocolatey, Homebrew, deb/rpm
launcher), `deploy/` (10 PaaS templates), `operator/` (OLM), `distribution/`, `loop/`,
`bin/` (npx launcher), `tsup.config.ts` + `tsconfig.lib.json` (npm library build), the
translated READMEs, `CONTRIBUTORS.md`, SonarCloud/Codecov config, 14 upstream workflows,
and ~40 tests that pinned those files. `src/exports/` is still present because tests
reference it; it can go with the UI/API split.

## 7. Working on the repo

- `bun run lint` · `bun run typecheck` · `bun run build`
- Core tests: `bash tests/run-core.sh` — **per-file processes on purpose**; `bun test` over
  several directories at once produces ~150 false failures from `mock.module` leaking.
- Component tests: `bash tests/run-components.sh`
- Integration tests need `docker compose -f database-compose.yml up -d`.
- Coverage gate: 100 % line coverage (`bun run coverage:check`). New code ships with tests.
- Known local-only failure: `tests/unit/db/sqlite-driver.test.ts` needs `node:sqlite`,
  present in bun ≥ 1.4 (CI pins 1.4.2).
- Chart tests render with `helm`; run `helm dependency build charts/libredb-studio` once.
- Image: `ghcr.io/klinux/dbportal:main` on every push to `main`; `v*` tags publish semver
  + `latest`. Chart `appVersion` must equal `package.json` version (`bun run chart:check`).
