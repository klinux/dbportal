# dbportal

Shared database portal: datasources created by admins and shared, SSO, and an audit trail
of every execution. Snapshot of LibreDB Studio 0.16.0 (MIT) — not a fork, no upstream
tracking. See NOTICE.md.

**Start with [docs/CONTEXT.md](docs/CONTEXT.md)** — origin, verified gaps, roadmap with the
intended design per feature, decisions taken, and what was removed. It is the project's
memory; keep it updated in the same PR as any change of direction.
Visual system and the in-product reference screen: [docs/DESIGN.md](docs/DESIGN.md).

## Stack
Next.js 16 (App Router + API routes, one process) · React 19 · Bun · TypeScript only.
Tailwind + Radix for UI. No Go, no Rust.

## Layout
- `src/app/api/db/{query,multi-query,transaction,maintenance}/route.ts` — the four
  execution routes; the control points for audit.
- `src/lib/db/providers/` — 16 engine drivers behind `DatabaseProvider` (`src/lib/db/types.ts`);
  `src/lib/db/factory.ts` caches providers per connection.
- `src/lib/seed/` — managed datasources from YAML; `resolve-connection.ts` decides seed
  (`connectionId: "seed:…"`) vs. client-supplied `connection` (the path to close, see CONTEXT §4.1).
- `src/lib/auth.ts`, `src/lib/api/require-session.ts` — JWT session, `Role = "admin" | "user"`.
- `src/lib/audit.ts` — `emitAuditEvent`: stdout JSON line (authoritative) + in-memory ring
  buffer (UI only). Closed `AuditReason` union; never free text.
- `src/lib/storage/` — per-user state in one `user_storage` table (`local` | `sqlite` | `postgres`).
- `src/lib/db/operations/execution.ts` — `executeAuditedOperation`, the policy→audit→driver
  pipeline (agent-only today; generalise it, don't duplicate it).
- `charts/dbportal/` — Helm chart. `docker/`, `Dockerfile`.
- `public/brand/` — logo SVGs and OG image, generated from docs/DESIGN.md.

## Commands
`make dev` / `make stop` (local environment: PostgreSQL in Docker + `bun run dev`); `make help`.
`bun run lint` · `bun run typecheck` · `bun run build`
`bash tests/run-core.sh` · `bash tests/run-components.sh` · `bun run test:ci` (both)
Single file: `bun test tests/unit/foo.test.ts`. Integration: `docker compose -f database-compose.yml up -d`.

## Rules
- Run test suites through `tests/run-core.sh` / `run-components.sh`. `mock.module` is
  process-wide in bun; running many files in one process yields ~150 false failures.
- 100 % line coverage is enforced (`bun run coverage:check`). New code ships with tests,
  written in the repo's style (a comment saying *why* the test exists, then the assertion).
- `emitAuditEvent` never receives credentials, tokens, connection strings, raw
  `Error.message`, or headers. SQL text only behind the explicit `AUDIT_INCLUDE_SQL` flag
  once that lands.
- Don't mass-replace `libredb`/`LibreDB`. Many occurrences are functional (storage keys,
  env vars, engine type `libredb`, chart name). Rebrand is a separate layered pass.
- Chart `appVersion` == `package.json` version; `bun run chart:check` gates CI.
- No organisation or customer names anywhere in the repo. It is public.
- Commit messages: imperative subject, a body that says why, and
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` when Claude wrote the change.
- `tests/unit/db/sqlite-driver.test.ts` fails locally on bun < 1.4 (`node:sqlite`); CI is on 1.4.2.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
