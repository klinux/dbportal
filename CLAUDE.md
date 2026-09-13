# dbportal

Shared database portal: central datasources, SSO, audit trail of every execution.
Snapshot of LibreDB Studio 0.16.0 (MIT) — not a fork, no upstream tracking. See NOTICE.md.

## Stack
Next.js 16 (App Router, API routes) · React 19 · Bun · TypeScript only. No Go/Rust.

## Layout
- `src/app/api/db/*` — execution routes (`query`, `multi-query`, `transaction`, `maintenance`). The control points for audit.
- `src/lib/db/providers/` — the 16 engine drivers behind one `DatabaseProvider` interface (`src/lib/db/types.ts`).
- `src/lib/seed/` — managed datasources from YAML (`resolveConnection` decides seed vs. client-supplied connection).
- `src/lib/auth.ts`, `src/lib/api/require-session.ts` — session, `Role = "admin" | "user"`.
- `src/lib/audit.ts` — `emitAuditEvent`: stdout JSON line (authoritative) + in-memory ring buffer (UI only).
- `src/lib/storage/` — per-user state, single `user_storage` table (local / sqlite / postgres).
- `charts/` — Helm chart. `docker/` — image assets.

## Commands
`bun run lint` · `bun run typecheck` · `bun run test:unit` · `bun run test:ci` · `bun run build`
Integration tests need `docker compose -f database-compose.yml up -d`.

## Rules
- Tests run per-file in separate bun processes (`tests/run-core.sh`) because `mock.module` is process-wide. Don't "optimise" that away.
- 100% line coverage is enforced (`coverage:check`). New code ships with tests.
- Never log credentials, tokens, connection strings or raw `Error.message` through `emitAuditEvent`; SQL text is allowed only behind the explicit audit flag being built.
- `libredb`/`LibreDB` strings still exist throughout (storage keys, env vars, engine type `libredb`). Rebrand is a deliberate, separate pass — do not mass-replace.
