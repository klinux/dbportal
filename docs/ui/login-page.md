# Login Page

The sign-in page is a split layout: the product's statement on the left, the form on the
right. It adapts between OIDC (SSO) and local (email/password) modes, and it claims nothing a
visitor could not verify once inside (docs/CONTEXT.md §2).

---

## Architecture

```
src/app/login/
├── page.tsx           # Server component — reads NEXT_PUBLIC_AUTH_PROVIDER at request time
└── login-form.tsx     # Client component — all UI and auth logic
src/components/brand-mark.tsx   # BrandMark (the glyph) and Wordmark, generated from docs/DESIGN.md
```

**`page.tsx`** is a server component with `export const dynamic = 'force-dynamic'` so the auth
provider variable is read at runtime (the container image does not know it at build time).

**`login-form.tsx`** receives `authProvider` as a prop and renders the form for `"oidc"` or
`"local"` (default).

---

## Layout

### Desktop (lg and above)

```
┌─────────────────────────────┬──────────────────────┐
│  [mark] dbportal            │   Right panel        │
│                             │                      │
│  Shared access to the       │   ┌──────────────┐   │
│  databases you already run. │   │ Welcome back │   │
│  One portal, deployed next  │   │ Sign in to   │   │
│  to your data …             │   │ dbportal     │   │
│                             │   │              │   │
│  • Datasources configured   │   │  [Form]      │   │
│    once                     │   │              │   │
│  • Access granted per       │   │  OIDC: SSO   │   │
│    datasource               │   │  or email/pw │   │
│  • One sign-in              │   └──────────────┘   │
│                             │                      │
│                             │  Access is granted   │
│                             │  per datasource … vN │
└─────────────────────────────┴──────────────────────┘
```

The left panel is the lockup, one heading, one subhead and **three product statements**
(`PRODUCT_POINTS` in `login-form.tsx`): datasources configured once by an administrator,
access granted per datasource by the server, one sign-in (local accounts or OpenID Connect).
Each is true of every deployment, which is why they are literals and not derived counts: the
upstream hero's engine wall, install-channel counts, connection-string ticker and social row
described a product this snapshot is not (docs/CONTEXT.md §5, layer 1), and were removed
rather than reworded.

### Mobile (below lg)

- The left panel is hidden (`hidden lg:flex`); a compact lockup appears above the card
  (`lg:hidden`) using `<h2>`, so the page keeps one `<h1>`.
- Card title: "Welcome back" (desktop) / "Sign in" (mobile); the description adapts per
  viewport.

---

## Authentication Modes

### OIDC Mode (`NEXT_PUBLIC_AUTH_PROVIDER=oidc`)

The right panel shows a **"Login with SSO"** button that redirects the whole page to
`/api/auth/oidc/login`, and the "Encrypted" / "OIDC Protected" badges. The login route
handles PKCE; the callback route creates the local JWT session — carrying the role mapped
from claims and the groups from `OIDC_GROUPS_CLAIM` (docs/CONTEXT.md §4.4) — before
redirecting to `/` or `/admin`.

### Local Mode (`NEXT_PUBLIC_AUTH_PROVIDER=local`, default)

Email and password, posted to `/api/auth/login`. What the form shows on each answer:

- Wrong email or password → `"Invalid email or password"` (401). One message for both, so the
  page never says which accounts exist.
- TOTP account, no code yet → the code field appears (401, `mfaRequired: true`) with no error
  toast: the field appearing is the message.
- TOTP account, wrong or replayed code → `"Invalid authentication code"` (401), toasted, and
  the field is cleared.
- Server not configured (missing `ADMIN_PASSWORD`, or a missing/too-short `JWT_SECRET`) → the
  actionable `AuthConfigError` message (503), never a misleading "Invalid email or password".

**Zero-config first run:** if `ADMIN_PASSWORD` / `JWT_SECRET` are missing they are generated
at boot and the admin password is printed once to the server log (`src/lib/auth-bootstrap.ts`).
Set `AUTH_BOOTSTRAP=off` to disable generation and get the 503 above instead. The default
accounts are `admin@dbportal.test` and, when `USER_PASSWORD` is set, `user@dbportal.test`
(`ADMIN_EMAIL` / `USER_EMAIL` rename them).

---

## Files

| File | Purpose |
|------|---------|
| `src/app/login/page.tsx` | Server component; reads the auth provider at request time |
| `src/app/login/login-form.tsx` | The page: lockup, product statements, and both forms |
| `src/components/brand-mark.tsx` | `BrandMark` and `Wordmark`, the only place the logo is drawn |
| `src/app/api/auth/login/route.ts` | Local login: uniform 401, TOTP second step, rate limits, audit |
| `src/app/api/auth/oidc/login/route.ts`, `…/callback/route.ts` | The SSO redirect and its return |

## Environment Variables

| Variable | Effect on this page |
|----------|---------------------|
| `NEXT_PUBLIC_AUTH_PROVIDER` | `local` (default) or `oidc`; decides which form renders |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `USER_EMAIL`, `USER_PASSWORD` | The local accounts (`docs/SECURITY.md`) |
| `ADMIN_TOTP_SECRET`, `USER_TOTP_SECRET` | Turn the second step on per account (`docs/MFA.md`) |
| `AUTH_BOOTSTRAP` | `off` disables the generated first-run credentials |

## Customization

The product statements are literals in `PRODUCT_POINTS`; change them there, and only to
something every deployment can stand behind. Colours and type come from the tokens in
`src/styles/theme.css` (docs/DESIGN.md); the logo from `src/components/brand-mark.tsx`.
