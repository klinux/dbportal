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
| Admins can still keep browser-local connections | [`src/lib/seed/resolve-connection.ts`](../src/lib/seed/resolve-connection.ts) — the `connection` body field is accepted only for `role === "admin"` (§4.1 step A) | Shared datasources now live server-side (§4.1 step B: seed YAML + the admin CRUD, one list). What remains is the admin's own browser-stored connections and the built-in samples, which the studio still lets an admin create and which nobody else can see. Removing that path is the last piece of §4.1. |
| No server-side audit of human queries | [`src/app/api/db/query/route.ts`](../src/app/api/db/query/route.ts) and siblings `multi-query`, `transaction`, `maintenance` | The routes call the provider directly with no `emitAuditEvent`. Query history is written **client-side** (`use-query-execution.ts` → `storage.addToHistory`), capped at 500 per user, and the user can clear it. The admin "Audit" tab reads the admin's own history. |
| Audit channel excludes SQL by design | [`src/lib/audit.ts`](../src/lib/audit.ts) — "What must never be recorded here: … SQL text" | The stdout JSON channel records logins, denials, maintenance — never the statement. The in-memory ring buffer holds 1000 events per process. |
| Two-role RBAC | [`src/lib/auth.ts`](../src/lib/auth.ts) — `type Role = "admin" \| "user"` | Seed YAML supports `roles: ["admin"]` / `["*"]`. No groups, no per-datasource read/write matrix. |
| Static shared credentials | [`src/lib/db/factory.ts`](../src/lib/db/factory.ts) — provider cache keyed by connection | Every user shares the database role; the database's own logs cannot name the person. |
| Masking is client-side | [`src/lib/data-masking.ts`](../src/lib/data-masking.ts) | Column-name regex in the browser; `salary AS x` escapes it; the API returns raw values. |
| Only the AI agent path is policy-checked | [`src/lib/db/operations/execution.ts`](../src/lib/db/operations/execution.ts) — `executeAuditedOperation` | Policy → audit → budget → driver pipeline exists, but only for agent runs and only on PostgreSQL/SQLite/DuckDB. It is the best piece to generalise to the human editor path. |

## 4. Roadmap, in order, with the intended design

### 4.1 Datasources are created by admins only, and shared ← **next**

Two steps. The first closes the hole; the second delivers the product.

**Step A — close the client-supplied connection path — done:**
- `resolveConnection` refuses `body.connection` for any role but `admin` with
  `SeedConnectionError(403)` before a provider is built, and records the denial through
  `auditRoleDenial` ([`src/lib/api/role-denial.ts`](../src/lib/api/role-denial.ts), target
  `connection:client-supplied`, reason `insufficient_role`). The helper moved out of
  `require-session.ts` because that module reaches the resolver through `errors.ts`.
- UI: `Studio.tsx` derives `openConnectionEditor` / `editConnection` /
  `duplicateConnection` from `isAdmin` and hands `undefined` to the sidebar, the mobile
  header, the mobile connections tab and the command palette; each drops its control.
  The managed list is untouched.
- The list follows the rule too: `GET /api/connections/managed` returns only `managed:true`
  seeds (and no pending sample) to a non-admin session, and `useConnectionManager(storageReady,
  localConnections)` skips browser-stored connections and editable seed copies when the flag
  is false. `Studio` passes `isAdmin`, which is false until `/api/auth/me` answers, so every
  session starts on the managed list and an admin's own connections join a moment later -
  the other order would open a non-admin's stored connection and greet them with the 403.
  The built-in samples (`managed:false` seeds) are therefore admin-only by construction.

**Step B — server-side shared datasources — done, one piece open:**
- Store: [`src/lib/datasources/store.ts`](../src/lib/datasources/store.ts). A record is a
  `SeedConnection` (same zod schema, same `${ENV_VAR}` credential resolution) plus who
  wrote it and when, persisted in `user_storage` under the reserved owner
  `shared:datasources` in the `connections` collection — so it inherits credential
  encryption from the one choke point every storage write passes through, with no second
  table and no second encryption path. `login()` refuses to mint a session for that owner
  id. Needs `STORAGE_PROVIDER=sqlite|postgres`; on `local` the API answers 503 and the
  seed YAML alone is served. Reads are cached 5 s; writes refresh the cache.
- One list: `getManagedConnections()` = seed YAML first, then the store; the YAML wins an
  id collision (version control is the operator's explicit statement), and a store that
  cannot be read costs only the runtime records. A shared datasource is always
  `managed: true` and is opened by the same `seed:<id>` handle as a YAML one.
- API: `GET/POST /api/admin/datasources`, `PUT/DELETE /api/admin/datasources/[id]`
  (admin-only, role denials audited, every mutation a `managed_connection` audit event,
  secrets never returned — the view says `hasPassword` / `passwordEnv`). An update that
  omits a secret keeps the stored one. `POST` refuses an id the YAML declares (409).
- UI: `/admin/datasources` ([`DatasourcesTab`](../src/components/admin/tabs/DatasourcesTab.tsx)),
  grouped by **environment** (production → staging → development → local → other), the
  YAML datasources listed read-only beside the runtime ones. The editor is the studio's
  `ConnectionModal` with `heading` / `submitLabel` / `extraFields` (roles, secret note);
  it tests the connection before saving, and `resolveConnection` resolves an admin's
  `${ENV_VAR}` reference in that test so the value never travels through the browser.
- **Open:** admins can still create browser-local connections in the studio (the
  `connection` body field on the `src/app/api/db/*` routes, and the built-in samples).
  Closing it means the studio's "New connection" for admins becomes "New datasource",
  the samples become admin-only demo seeds or go, and the body field is removed.

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

### 4.8 UI: configuration dialogs are side sheets (done)

The connection/datasource editor (`src/components/ConnectionModal.tsx`), the create-table
editor and the data-import wizard open in a **Sheet** anchored to the right edge at
**50 % of the viewport**, full height (`CONFIG_SHEET_CLASS` in
[`src/lib/ui/config-sheet.ts`](../src/lib/ui/config-sheet.ts), one string so the three
cannot drift; the mobile Drawer stays). A sheet keeps the list it was opened from visible,
gives a long form its full height, and does not fight the page for the centre. The
save-query prompt and the masking-rule dialog stay centred: they are one-field prompts,
not configuration. Requested 2026-09-13.

## 5. Decisions already taken

- **TypeScript stays.** The 50k-line driver layer is the main asset; rewriting the backend
  in Go would throw it away to gain a static binary. If a Go component ever makes sense it
  is a wire-protocol proxy beside dbportal, not inside it.
- **UI and API will be separated** eventually (the Next.js monolith with API routes is the
  weakest structural point), but not before 4.1 and 4.2 ship.
- **Rebrand is a separate, deliberate pass, in layers.** Many occurrences are functional:
  storage keys (`libredb_*` collections, `libredb-storage.db`), env var names, the `libredb`
  engine type and its `@libredb/libredb` dependency, the audit line schema
  `libredb.audit.v1`, the chart name `charts/libredb-studio`. Do not mass-replace.
  - *Layer 1 — what the browser shows* (done): login page rebuilt around the dbportal
    lockup and three product statements (`src/components/brand-mark.tsx`); the upstream
    marketing hero (engine showcase, install-channel counts, connection-string ticker,
    social row) and the "star us on GitHub" prompt were removed rather than reworded, since
    none of them describes this product. Sidebar lockup, repository link, error page.
  - *Layer 2 — operator-facing strings* (done): startup banner (the "star the project"
    line became a plain `Source:` line), bootstrap/preflight/agent-config console messages,
    the agent's system prompt, the Trino kill message, the container bind-resolver log
    prefix, `.env.example` / Dockerfile / compose headers, and the product name across
    `docs/`. What `docs/` still says about the *npm package*, the *npx launcher* and
    *libredb-platform* describes upstream channels this snapshot removed (§6); pruning
    those is a docs audit, not a rename, and is still open. `docs/ui/login-page.md`
    describes the upstream login hero that layer 1 replaced.
  - *Layer 3 — with migration*: `LIBREDB_*` env vars (accept both names for a release),
    storage keys (migrate on read), chart name, `libredb.audit.v1` schema id, the
    `admin@libredb.org` / `user@libredb.org` default account emails, the health route's
    `service: "libredb-studio"` field and the Trino `X-Trino-Source` client name.
  - *Never*: the `libredb` engine type and the `@libredb/libredb` package.
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
