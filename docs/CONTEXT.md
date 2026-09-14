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
| Two-role RBAC | [`src/lib/auth.ts`](../src/lib/auth.ts) — `type Role = "admin" \| "user"` | Seed YAML supports `roles: ["admin"]` / `["*"]`. No groups, no per-datasource read/write matrix. |
| Static shared credentials | [`src/lib/db/factory.ts`](../src/lib/db/factory.ts) — provider cache keyed by connection | Every user shares the database role; the database's own logs cannot name the person. (§4.3 labels the pool per person; §4.5 issues a credential per person through Vault.) |
| Masking is client-side | [`src/lib/data-masking.ts`](../src/lib/data-masking.ts) | Column-name regex in the browser; `salary AS x` escapes it; the API returns raw values. (§4.7 moves the rules to the server; the alias escape remains, see there.) |
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
- **Closed (2026-09-13):** no route reads a connection object any more. `resolveConnection`
  takes `connectionId` only (a `connection` field is a 400 for an admin and an audited 403
  for anyone else); the one exception is `POST /api/db/test-connection`, which tests an
  admin's DRAFT through `resolveDraftConnection` before the datasource is saved. The browser
  always sends a reference (`buildConnectionPayload`), the connection manager lists the
  server's answer alone (no browser-stored rows, no seed copies, no `dismissed_seeds`), the
  built-in samples are `managed: true`, and the studio's "+" takes an admin to
  `/admin/datasources`. `ConnectionModal` now lives only on that page.
- Cleanups done (2026-09-13): `resolveAgentRunConnectionId` is the seed reference and nothing
  else (the copy-vs-seed comparison, its relevance maps and the served-seeds plumbing are
  gone), and the browser no longer holds a `connections` list or `dismissed_seeds` — the
  storage facade lost those methods, the sync hook those collections. The `connections`
  collection itself stays: the shared datasource store keeps its records there.

### 4.2 Server-side audit of every execution — done, persistence open

- [`src/lib/audit-execution.ts`](../src/lib/audit-execution.ts): `auditExecution(context,
  invoke)` wraps the provider call in `query`, `multi-query` (one record per statement) and
  `transaction` (begin/commit/rollback/query); `maintenance` already had its own event. One
  `query_execution` event per execution: person, datasource, action, outcome, duration,
  address, and on failure a closed reason derived from the driver error's CLASS
  (`query_error`, `query_timeout`, `query_cancelled`, `database_auth_error`,
  `database_config_error`, `execution_failed`) — never its message. A failing sink is
  logged and never turns a finished query into a 500; the error is rethrown untouched.
- The statement is recorded only under `AUDIT_INCLUDE_SQL=true`: the wrapper puts it in
  `details` under that flag alone, and `toAuditLine` copies `details` to a `statement` key
  only for `query_execution` events under the same flag — every other event's `details`
  stays off the line. Bounded to 254 characters and URI-credential-redacted like any field.
- The admin Audit tab's Queries and Stats read `GET /api/admin/audit?type=query_execution`
  (the server's buffer), not the admin's own browser history; a list without statements
  says which flag turns them on.
- Persistence: with `STORAGE_PROVIDER=sqlite|postgres`, every event is also appended to an
  `audit_events` table (id, ts, type, JSON of the sanitized event) — append-only by
  contract, no update or delete anywhere, unreachable through the per-user storage routes.
  The sink is registered at boot ([`src/lib/audit-persistence.ts`](../src/lib/audit-persistence.ts))
  and is fire-and-forget: the stdout line is already out, and a store that is down fails
  the event (logged) and never the request. `GET /api/admin/audit` reads the store when
  there is one (`source: "store"`) and the per-process ring buffer otherwise. On `local`
  the stdout pipeline remains the only durable channel.

### 4.3 `application_name` per user — done

Every route obtains its provider with `{ applicationName: applicationNameFor(user) }`
(`<user>@dbportal`, 63 chars, ASCII — [`src/lib/db/application-name.ts`](../src/lib/db/application-name.ts)),
and `getOrCreateProvider` caches **one pool per (datasource, person)** under that label,
capped at `PER_USER_POOL_MAX = 3` connections unless the caller sized it. PostgreSQL gets
`application_name`, MySQL `connectAttributes.program_name`, SQL Server `options.appName`,
MongoDB `appName`; the other engines ignore the option. So `pg_stat_activity`, pgAudit,
`session_connect_attrs`, `sys.dm_exec_sessions` and `currentOp()` name the person behind
the shared role — a second audit trail the database keeps itself. A side effect worth
knowing: a transaction opened by one person no longer shares its pool with another's.
`removeProvider(connectionId)` closes the shared pool and every person's pool for it.

### 4.4 Access rules: groups, and who may write — done

Deliberately two lists and one vocabulary, nothing more ([`src/lib/access.ts`](../src/lib/access.ts)):

- A session's **principals**: `*`, its role, and `group:<name>` for each group the identity
  provider put in the token (`OIDC_GROUPS_CLAIM`, default `groups`; bounded to 50 × 64
  chars before signing; local accounts have none). Carried in the JWT, so no store is
  consulted per request.
- A datasource's `roles` (who may open — the list the YAML always had, now accepting
  `group:<name>`) and `writeRoles` (who may write; absent = everyone who can open, `[]` =
  nobody, administrators included).
- Enforcement, server-side, before the provider: `assertWriteAllowed`
  ([`src/lib/api/write-gate.ts`](../src/lib/api/write-gate.ts)) in `query`, `multi-query`
  (whole script judged first), `transaction` (the statement, not the envelope) and
  `maintenance` (every operation writes). A read is SELECT / read-only WITH / SHOW /
  DESCRIBE / EXPLAIN-of-a-read; an engine without SQL text is refused entirely under a
  read-only rule. Refusal: 403 + audited `permission_denied` / `read_only_datasource`.
- Defense in depth where the engine has it: a read-only session's pool is opened with
  `default_transaction_read_only=on` on PostgreSQL (cache key `::ro`), so a SELECT calling
  a writing function is refused by the database. Other engines rely on the gate.
- UI: `GET /api/connections/managed` reports `readOnly` per session (the sidebar badge);
  the datasource editor takes group names and a write mode (everyone / admins / nobody;
  a custom rule from the API or YAML is shown and kept).

### 4.5 Ephemeral credentials (Vault) — done

A credential reference the datasource carries instead of a value, resolved on the server
when the datasource is opened — the value never sits in the seed file, the store, or the
browser ([`src/lib/vault/`](../src/lib/vault/), docs/SEED_CONNECTIONS.md "Vault references"):

- `vault:kv:<mount>/<path>#<key>` — a KV v2 field, read once per `VAULT_KV_TTL_MS`.
- `vault:db:<mount>/<role>` — the database secrets engine issues a user + password with a
  lease, **per person** (cache key `<role>::<username>`), re-issued at 80% of the lease.
  Each issue is a `credential_issued` audit event (success or `credential_provider_failed`),
  which joins the database's own log (it names the issued user) to the person.
- No client library: two GETs with a token header (`VAULT_TOKEN` or `VAULT_TOKEN_FILE`, read
  per call), a per-request timeout, errors that name the path and never the token or a value.
- Wiring: `resolveConnection` and `resolveDraftConnection` resolve references after `${ENV}`
  ones; a Vault failure is a 503 that names the datasource (Vault's words stay in the server
  log), a malformed reference a 400. `getOrCreateProvider` replaces a cached pool whose
  user/password/connectionString differ from the freshly resolved connection, the same way
  it already did for a changed `queryTimeout` — that is what makes a re-issued lease reach
  the pool before Vault revokes the old user. The cache lives on `globalThis`
  (`Symbol.for("dbportal.vault-cache")`) for the same reason the audit sink does.
- Deliberately not done: lease renewal (`sys/leases/renew`) — re-issuing is one code path
  and Vault revokes the old user on its own; and Vault auth methods beyond a token (AppRole,
  Kubernetes) — the injector/agent already turns those into a token file.

### 4.6 Approval flow — done

A write on a datasource declared `writeApproval: true` runs only inside an open **write
window**; otherwise it becomes a pending request and does not run
([`src/lib/approvals/`](../src/lib/approvals/), docs/SEED_CONNECTIONS.md "Writes that need a
reviewer"). Deliberately a window and not "execute on approval": the reviewer grants a
person bounded access (1–240 min, default 15), and the person, who is present, runs the
statement again and sees the result — the server never executes a stored statement on
someone's behalf later.

- Gate: `assertWriteAllowed` (§4.4) gained the step after the read-only check: a write on
  such a datasource looks for an approved request of this person with `windowUntil` in the
  future, else creates the pending request (one per person and datasource, statement bounded
  to 4 KB, the first offending statement of a script) and throws `ApprovalRequiredError` →
  403 `APPROVAL_REQUIRED` with the request, plus an audited `permission_denied` /
  `approval_required`. Maintenance goes through the same gate now.
- Store: `approval_requests` table beside `audit_events` in both server stores; without a
  server store the write is a 503 that says what to configure. Reviewers: the datasource's
  `approverRoles` or administrators (`canApprove`); nobody reviews their own request.
  `GET /api/approvals` (reviewer's list, `?scope=mine` for one's own), `GET/POST
  /api/approvals/[id]` (`{ decision, windowMinutes?, note? }`).
- Audit: `approval_decision` event with `approvalId` + `reviewer`; every execution inside the
  window carries both on its `query_execution` line (`approval_id`, `reviewer`) — "who let
  this run" without joining two systems.
- UI: the tab parks the request (`QueryTab.approval`) and shows the waiting state in the
  result area; `useWriteApprovals` polls the request every 5 s while it waits, toasts the
  decision, and holds the windows this person has (read once on load); the toolbar shows
  the countdown chip (DESIGN.md "Write window"), 00:00 in the denied palette once closed.
  Admin → Approvals lists pending requests with the statement and approves for 15/60/240
  min or rejects. The datasource editor has a "Writes need approval" checkbox.
- Not done: reviewer notifications (the list is polled by the page), and a reviewer UI
  outside the admin area for group approvers (the API already admits them).

### 4.7 Server-side masking — done

The rules did not change; where they run did ([`src/lib/masking/store.ts`](../src/lib/masking/store.ts)):

- One masking configuration, an administrator's, held in the server store under the
  reserved owner `shared:masking` (`GET/PUT /api/admin/masking`, validated: bounded lists,
  every column pattern a regex that compiles) and read by every session (`GET /api/masking`)
  so the grid's badges and reveal offer follow the same rules. Without a store, or with
  nothing saved, the built-in defaults apply — a deployment that configured nothing still
  masks the obvious columns.
- `maskResult` runs in the query, multi-query and transaction routes before the rows leave
  (`masked: string[]` names the columns); a plan is not rows and is not masked. The browser
  never receives a value the rule masks.
- Reveal is a request (`reveal: true`), granted to the roles the configuration names
  (`roleSettings.*.canReveal`), refused with a 403 otherwise, and audited as
  `masking_reveal` naming the columns — never the values (DESIGN.md: "unmasking is itself
  an audited action"). The studio asks for it when someone who may reveal turns masking
  off; the admin Security → Masking page saves to the server.
- Still open, on purpose: matching is by result column name, so `salary AS x` still
  escapes it. Closing that needs the engine's origin metadata per column (PostgreSQL gives
  `tableID`/`columnID`, most engines give nothing), a different piece of work from moving
  the rules server-side; the alias is at least visible in the audited statement.

### 4.8 UI: configuration dialogs are side sheets (done)

The connection/datasource editor (`src/components/ConnectionModal.tsx`), the create-table
editor and the data-import wizard open in a **Sheet** anchored to the right edge at
**50 % of the viewport**, full height (`CONFIG_SHEET_CLASS` in
[`src/lib/ui/config-sheet.ts`](../src/lib/ui/config-sheet.ts), one string so the three
cannot drift; the mobile Drawer stays). A sheet keeps the list it was opened from visible,
gives a long form its full height, and does not fight the page for the centre. The
save-query prompt and the masking-rule dialog stay centred: they are one-field prompts,
not configuration. Requested 2026-09-13. The engine picker in that editor is a dropdown
(icon + name per option, disabled in edit mode) rather than the seventeen cards it was:
in a half-width sheet the cards pushed the form itself below the fold. In the studio the
sidebar's flat connection list became one **datasource row** (`ConnectionPicker`) whose
popover lists datasources grouped by environment, production first, searchable from six
entries (`ConnectionsList`, also the mobile tab's inline list): with every datasource shared
and declared server-side, a list was taking the space the object tree needs. The admin
datasources page shows one **tab per environment** (production first, count on the tab)
instead of stacked sections: a fleet of a hundred datasources is read one environment at a
time. SSH profiles (§4.9) live under **Security → SSH profiles**, with the other settings
only an administrator sets, so the datasources page holds datasources alone.
Every admin section now opens the same way: the page wrapper's gutter
(`mx-auto max-w-7xl px-4 sm:px-6 py-6`), then `AdminSectionHeader` (brand icon, name, one
sentence, actions on the right), then content; sub-tabs share one pair of classes
(`src/lib/ui/admin-tabs.ts`). Monitoring, which used to be a full-bleed page with a header
bar and token family of its own, renders inside that frame, and the studio's `/monitoring`
route wraps the same dashboard in the admin shell's title bar and gutter, so the two never
drift apart. Screenshots of every page live in
`docs/screenshots/` (regenerated by `scripts/screenshots.mjs`) and are shown in the README.

### 4.9 SSH profiles — done

A datasource used to carry its own bastion block; ten datasources behind one bastion were
ten copies of the same key, and a managed datasource had no way to declare one at all. A
profile is now declared once — `sshProfiles:` in the seed file, or the admin page's
Security → SSH profiles tab, stored under the reserved owner `shared:ssh-profiles` with its secrets
sealed by the same encrypting layer as a tunnel's — and a datasource names it with
`sshProfile: "<id>"` ([`src/lib/ssh-profiles/`](../src/lib/ssh-profiles/)). `resolveConnection`
builds `sshTunnel` from the profile when the datasource is opened (secrets as values,
`${ENV_VAR}` or `vault:kv:` references), so the record never holds the key and the browser
never sees it; the editor's inline SSH panel became a profile select. A profile a datasource
names cannot be deleted (409); a seed-file profile is read-only in the admin page. Not done:
per-profile connection pooling across datasources — each datasource still opens its own
tunnel to the same bastion.

### 4.10 Executions from a bot — done

A Slack bot (or any program) asks for a statement to run on a datasource for a person, and
the request lands in the same queue reviewers already watch. Pieces, in the order they were
built: **service tokens** (`src/lib/service-tokens/`, `Security → Service tokens`,
`/api/admin/service-tokens`): a Bearer `dbp_…` whose SHA-256 is stored under the reserved
owner `shared:service-tokens`, with a role, groups, an optional datasource allowlist and a
`requireApproval` flag; the audit actor is `svc:<name>`, revocation keeps the row.
**The queue** (`src/lib/executions/`, `POST /api/v1/executions`,
`GET /api/v1/executions/[id]`): a request `{ datasourceId, statement, onBehalfOf, reply? }`
is an `approval_requests` record of `kind: "execution"` carrying the person as `subject`;
policy decides at submission — a read on a datasource without `writeApproval`, from a token
without `requireApproval`, runs at once (200) — otherwise it waits (202) on
`/admin/approvals`, where **approving runs that exact statement on the server** instead of
opening a window (the requester is absent; a fixed text is safer than a period), and the
bounded, masked outcome is stored on the record for the bot to read back. The audit line is
the ordinary `query_execution` with the token as actor, the person as `subject` and the
reviewer when there was one. **The Slack notifier** (`src/lib/notify/slack.ts`,
`SLACK_BOT_TOKEN`, `SLACK_APPROVALS_CHANNEL`, `APP_URL`): best effort, a pending request is
announced to the reviewers' channel with a link to the page, and the outcome is posted into
the thread the request named, with ten rows at most; the full result stays behind login.
Not done: a signed HTTP callback for bots outside Slack (they poll), Slack buttons on the
announcement (they need a signed interactivity endpoint), and expiry of stored outcomes.

### 4.11 → 4.20 The SRE/DevOps sequence (agreed 2026-09-14)

What an SRE team asks of a tool that sits in front of production, in the order it will be
built. Each lands as its own section when done.

- **4.11 `/metrics` — done.** `GET /api/metrics` ([`src/lib/metrics/registry.ts`](../src/lib/metrics/registry.ts)):
  a registry written by hand on `globalThis` (five series need no client library, and a
  module-level Map would be one registry per Next.js entry), fed from the two places every
  activity passes through - `emitAuditEvent` (`dbportal_audit_events_total` by event,
  action, outcome) and `auditExecution` (`dbportal_execution_duration_seconds` by route
  and datasource) - plus gauges computed at scrape time: pending approvals and the age of
  the oldest, cached providers, build info, uptime. Behind `METRICS_TOKEN` as a Bearer,
  which the middleware lets through on shape and the route verifies in constant time;
  unset, the endpoint is a 404. Labels are closed values and datasource names, never a
  person, a statement or an address.
- **4.12 Audit export to a SIEM — done.** [`src/lib/audit-export/elastic.ts`](../src/lib/audit-export/elastic.ts):
  with `AUDIT_ELASTIC_URL` (and an `AUDIT_ELASTIC_API_KEY`), every audit line - the same
  line stdout gets, `toAuditLine` - is queued and shipped to Elasticsearch through the
  Bulk API as NDJSON, `create` with the event's own id so a retry cannot duplicate,
  in batches of `AUDIT_ELASTIC_BATCH` or after `AUDIT_ELASTIC_FLUSH_MS`, retried three
  times with backoff and then dropped with one warning and a counter
  (`dbportal_audit_export_total{sink,outcome}`); the queue is bounded at ten thousand
  lines. Never a blocked request: an index that is down must not take the portal down.
  Retention: `AUDIT_RETENTION_DAYS` prunes `audit_events` in the server store, swept at
  most once an hour after an append (`pruneAuditEvents` on both providers). Wired in
  `src/lib/audit-persistence.ts`, one sink composed of the store and the exporter.
- **4.13 Readiness and liveness — done.** `GET /api/health/live` answers whenever the
  process does; `GET /api/health/ready` asks the server store (`isHealthy`) and Vault
  (`sys/health`, standby accepted, two-second timeout - [`src/lib/vault/health.ts`](../src/lib/vault/health.ts)),
  each only when configured, and is 503 while either fails, so a rollout keeps the old pod
  until the new one can serve and an outage of the store is not turned into a crash loop.
  Both are public paths like every probe; the body names outcomes, never addresses. The
  chart's probes point at them; `/api/db/health` stays as the older unconditional answer.
- **4.14 Backup and restore** — the portal's own store is managed (GCP) and backed up
  there. This is about the *datasources*: in development, a person dumps and restores a
  database from the portal; in production, an export to a bucket only, never a restore.
- **4.15 Guardrails per statement** — `DELETE`/`UPDATE` without `WHERE`, `DROP`,
  `TRUNCATE` need approval even from a writer; an automatic `EXPLAIN` before a write
  where the engine has one.
- **4.16 Limits per datasource** — maximum rows, statement timeout, concurrency per person.
- **4.17 Freeze windows** — no writes on a datasource (or anywhere) between two instants,
  declared once; a write inside the window is refused with the window's reason.
- **4.18 Ticket on every execution** — a `reason`/ticket field that travels into the audit
  line; required where the datasource says so.
- **4.19 Named roles** — beyond `admin`/`user`: a reviewer who does not administer, an
  on-call who writes only inside a window; groups from OIDC mapped to them.
- **4.20 Runbooks** — shared, parameterised saved queries per datasource.
- **4.21 Large and elaborate scripts** — verify, with a real `UPDATE … WHERE id IN (…)` of
  two thousand ids and a multi-statement script, what the portal does: known today, the
  approval record keeps the first 4000 characters of a statement for display (the editor's
  own run is not cut), the bot API refuses a statement over 4000 characters, the
  multi-query route splits statements per engine grammar, and every statement has the
  datasource's `queryTimeout` (60 s by default). To decide: raise the bot limit, stream a
  script statement by statement with one audit line each, and what a reviewer sees of a
  script that does not fit on a screen.
- **later** — Slack buttons on the approval message (a signed interactivity endpoint), the
  signed HTTP callback for bots outside Slack, shorter sessions with renewal.

## 5. Decisions already taken

- **TypeScript stays.** The 50k-line driver layer is the main asset; rewriting the backend
  in Go would throw it away to gain a static binary. If a Go component ever makes sense it
  is a wire-protocol proxy beside dbportal, not inside it.
- **UI and API will be separated** eventually (the Next.js monolith with API routes is the
  weakest structural point), but not before 4.1 and 4.2 ship.
- **Rebrand is a separate, deliberate pass, in layers.** Many occurrences are functional:
  storage keys (`libredb_*` collections, `libredb-storage.db`), env var names, the `libredb`
  engine type and its `@libredb/libredb` dependency, the audit line schema
  `dbportal.audit.v1`, the chart name `charts/dbportal`. Do not mass-replace.
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
    *libredb-platform* described upstream channels this snapshot removed (§6); that docs
    audit was done 2026-09-13 with layer 3, and `docs/ui/login-page.md` was rewritten for
    the page layer 1 built.
  - *Layer 3 — with migration* (done 2026-09-13):
    - `LIBREDB_*` env vars → `DBPORTAL_*` through `readEnv()` in
      [`src/lib/config/env-alias.ts`](../src/lib/config/env-alias.ts): the old name is read
      when the new one is unset, with one deprecation warning per name. The container's
      `LIBREDB_BIND` and the e2e script's `LIBREDB_MAIN_CHECKOUT` fall back the same way.
      **Drop the fallback one release after this.**
    - Browser storage keys `libredb_*` → `dbportal_*`, moved on first read
      (`migrateLegacyKey`); the server-migration flag accepts both; the DOM event is
      `dbportal-storage-change`. The theme key is a clean slate (the default theme once).
    - Default SQLite path `./data/dbportal-storage.db`; when unset and only the old
      `libredb-storage.db` exists, that file is used (`resolveStorageSqlitePath`).
    - Audit line schema id `dbportal.audit.v1` — a contract change for log consumers, done
      once here rather than kept forever.
    - Default accounts `admin@dbportal.test` / `user@dbportal.test`; while `ADMIN_EMAIL` /
      `USER_EMAIL` are unset the old `@libredb.org` addresses still log in (`legacyEmail`).
    - Chart `charts/dbportal` (helper names, labels, tag prefix `dbportal-`), health
      `service: "dbportal"`, Trino `X-Trino-Source: dbportal`, container lib path.
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

- `make dev` / `make stop` bring the local environment up and down (PostgreSQL from
  the `postgres` service of `database-compose.yml` plus `bun run dev`); `make help` lists the rest.
- `bun run lint` · `bun run typecheck` · `bun run build`
- Core tests: `bash tests/run-core.sh` — **per-file processes on purpose**; `bun test` over
  several directories at once produces ~150 false failures from `mock.module` leaking.
- Component tests: `bash tests/run-components.sh`
- Integration tests need `docker compose -f database-compose.yml up -d`.
- Coverage gate: 100 % line coverage (`bun run coverage:check`). New code ships with tests.
- Known local-only failure: `tests/unit/db/sqlite-driver.test.ts` needs `node:sqlite`,
  present in bun ≥ 1.4 (CI pins 1.4.2).
- Chart tests render with `helm`; run `helm dependency build charts/dbportal` once.
- Image: `ghcr.io/klinux/dbportal:main` on every push to `main`; `v*` tags publish semver
  + `latest`. Chart `appVersion` must equal `package.json` version (`bun run chart:check`).
