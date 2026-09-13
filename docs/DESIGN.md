# dbportal — Design System & Identity

## Overview
`dbportal` is a shared database portal for SRE, DevOps and developers: one deployment, one set of datasources, single sign-on, and an audit trail of every execution — so nobody needs a database password, a bastion host, or Adminer, and every statement that reaches a database is attributable to a person.

This bundle contains the visual identity (logo system) and the UI foundation (color, typography, components) plus one in-product reference screen (the query console, dark theme).

## Assets in this repository
The logo is shipped as SVG under [`public/brand/`](../public/brand/), generated from the
construction below (wordmark outlined from IBM Plex Mono SemiBold, so no font is needed to
render it):

| File | Use |
|---|---|
| `symbol.svg` | primary mark, on light |
| `symbol-dark.svg` | mark on `#0B0E14` |
| `symbol-mono.svg` | one-colour mark, on `#1F6FEB` or any solid |
| `app-icon.svg` | one-colour mark on signal blue — favicon, PWA, touch icon (rasterised in `public/`) |
| `lockup.svg` / `lockup-dark.svg` | horizontal lockup, 48px symbol + wordmark 30px |
| `stacked.svg` / `stacked-dark.svg` | stacked lockup, 24px wordmark |
| `og-image.png` | 1200×630 link preview |

The reference screen and component states are described in this document; the in-product
UI is to be built with the codebase's own primitives (Tailwind + Radix) using these tokens.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii and states. Recreate pixel-accurately with the codebase's own primitives. Every value below is authoritative.

---

## Design Tokens

### Color — neutrals (light)
| Token | Hex | Use |
|---|---|---|
| `canvas` | `#F4F6F8` | page background |
| `surface` | `#FFFFFF` | cards, inputs, panels |
| `border` | `#D7DDE4` | all 1px dividers and card borders |
| `border-strong` | `#C3CBD4` | input and secondary-button borders |
| `ink` | `#0B0E14` | primary text, logo |
| `slate-600` | `#4A5563` | body secondary text |
| `slate-500` | `#5C6672` | small labels / eyebrows on white (AA at 11px) |
| `slate-450` | `#5A6472` | hex values, helper text on white |

> Do **not** use `#8A94A1` / `#6E7A8A` on white — both fail 4.5:1 at small sizes. They were replaced by `#5C6672` / `#5A6472`.

### Color — neutrals (dark)
| Token | Hex | Use |
|---|---|---|
| `dark-canvas` | `#0B0E14` | app background, editor |
| `dark-surface` | `#11151D` | top bar, toolbars |
| `dark-panel` | `#0E121A` | audit rail panel |
| `dark-border` | `#232A36` | structural dividers |
| `dark-border-soft` | `#1A202A` | row separators |
| `dark-text` | `#E8ECF1` | primary text |
| `dark-text-2` | `#A7B1BE` | secondary text |
| `dark-text-3` | `#9AA5B2` | labels, metadata (min on dark) |

### Color — brand & status
| Token | Hex | Use |
|---|---|---|
| `signal-blue` | `#1F6FEB` | primary action, identity accent, focus |
| `signal-blue-hover` | `#1655B8` | primary button hover/active |
| `signal-blue-dark` | `#4E96FF` | blue on dark surfaces, SQL keywords |
| `focus-ring` | `#CFE0FD` | 2px outline on focused input |
| `committed` | `#147D58` | text/dot; bg `#EAF6F1`, border `#B9DECD` |
| `pending` | `#9A6200` | text/dot; bg `#FBF3E4`, border `#E8D2A6` |
| `denied` | `#C0342E` | text/dot; bg `#FCF2F1`, border `#E7B5B3` |
| `committed-dark` | `#7FD3AC` | success on dark |
| `pending-dark` | `#F0C476` | warning on dark; chip bg `#2A2113`, border `#4A3A1C` |
| `denied-dark` | `#E9807B` | failure on dark |

**Rule:** the three status colors describe the outcome of an execution only. Never decorative, never a brand accent.

### Typography
- **IBM Plex Sans** — all interface text. Weights 400 / 500 / 600.
- **IBM Plex Mono** — the wordmark, SQL, identifiers, hosts, hashes, timestamps, uppercase eyebrow labels. Weights 400 / 500 / 600.
- Load: `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap`

| Style | Spec |
|---|---|
| Display | Sans 34px / 600 / line-height 1.1 / letter-spacing -0.03em |
| Page title (marketing) | Sans 52px / 600 / lh 1.04 / ls -0.035em |
| Section heading | Sans 26px / 600 / ls -0.02em |
| Heading | Sans 20px / 600 / ls -0.015em |
| Body | Sans 15px / 400 / lh 1.6 |
| Caption | Sans 13px / 400 |
| Label (form) | Sans 13px / 500 |
| Eyebrow | Mono 11px / 400 / ls 0.06em / UPPERCASE |
| Code / SQL | Mono 13.5px / 400 / lh 1.75 |
| Data cell | Mono 12.5px / 400 |
| Chip / metadata | Mono 12px / 400 |

### Spacing, radius, elevation
- 4px spacing grid. Common steps: 4, 6, 8, 10, 12, 16, 24, 28, 32, 40, 56, 72.
- Radius: **6px** interactive controls (buttons, inputs), **10px** surfaces/cards, **12px** large app frames, **4px** chips/badges, **1px** on logo interior rows.
- **No shadows anywhere.** Structure is 1px borders only.
- Content max-width 1180px, page padding 32px.

---

## Logo

### Construction
48×48 viewBox. Two elements:
1. **Portal frame** — four corner brackets, `stroke-width: 3.5`, `stroke-linecap: square`, 3px corner radius arcs. Path:
   `M4 15V7a3 3 0 0 1 3-3h8M44 15V7a3 3 0 0 0-3-3h-8M4 33v8a3 3 0 0 0 3 3h8M44 33v8a3 3 0 0 1-3 3h-8`
2. **Table rows** — three `rect`s, `rx="1"`, height 5, x=13:
   - row 1: `y=14`, width 22 — **signal blue** (the executed/recorded row)
   - row 2: `y=21.5`, width 22 — ink
   - row 3: `y=29`, width 13 — ink

Meaning: a controlled opening (not an open door) framing a database table; the keyed row is the statement that gets attributed.

### Variants
| Variant | Frame | Row 1 | Rows 2–3 |
|---|---|---|---|
| Primary (on light) | `#0B0E14` | `#1F6FEB` | `#0B0E14` |
| Dark (on `#0B0E14`) | `#FFFFFF` | `#4E96FF` | `#FFFFFF` |
| One-color (on `#1F6FEB` or any solid) | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` |

At 20px the frame stroke goes to `4` for optical weight.

### Lockups
- **Horizontal**: symbol 48px + 16px gap + wordmark `dbportal` Mono 30px / 600 / ls -0.03em, vertically centered.
- **Stacked**: symbol 48px, 12px gap, wordmark Mono 24px / 600, left-aligned.
- **App header**: symbol 20px + 10px gap + wordmark Mono 14px / 600.

### Rules
- Clear space = one interior row height (1/8 of symbol) on all sides.
- Minimum size: symbol 20px; lockup 96px wide — below that use the symbol alone.
- Never: gradients, rotation, outline-only rows, capital D. The wordmark is **always lowercase mono**.

---

## Components

### Buttons — 14px / 500, radius 6px, padding 9px 16px, 1px border
| Variant | Idle | Hover |
|---|---|---|
| Primary | bg `#1F6FEB`, border `#1F6FEB`, text `#FFF` | bg/border `#1655B8` |
| Secondary | bg `#FFF`, border `#C3CBD4`, text `#0B0E14` | bg `#F4F6F8` |
| Destructive | bg `#FFF`, border `#E7B5B3`, text `#C0342E` | bg `#FCF2F1` |
| Disabled | bg `#F4F6F8`, border `#D7DDE4`, text `#5C6672` | none |
| Ghost / shortcut | transparent, no border, Mono 13px, text `#5A6472` | text `#1F6FEB` |

In-product (dark) primary: bg `#1F6FEB`, no border, radius 6px, padding 7px 14px, 13px / 500.

### Status badge
Mono 12px, radius 4px, padding 4px 9px, 1px border, 6px gap, optional 6px round dot in the text color. Variants use the status bg/border/text triples above. A neutral variant (`read-only`) uses bg `#F4F6F8`, border `#D7DDE4`, text `#4A5563`, no dot.

### Input
Label Sans 13px/500 → 6px gap → field: Mono 13px, bg `#FFF`, border 1px `#C3CBD4`, radius 6px, padding 9px 12px, full width.
Focus: border `#1F6FEB` + `outline: 2px solid #CFE0FD`.
Helper below: Sans 12px `#5A6472`; inline identifiers in Mono.

### Card / surface
bg `#FFF`, border 1px `#D7DDE4`, radius 10px, padding 22–28px, gap 16px column. No shadow.

---

## Screens / Views

### 1. Design-system reference page (light)
Purpose: canonical documentation. Single column, max-width 1180px, 72px between sections, 56/32/96px page padding.
Sections, each with a Mono 12px blue index (`01`…`05`) + 26px heading, 12px gap, baseline-aligned:
01 The mark · 02 Color · 03 Typography · 04 Components · 05 In product.
Grids are `repeat(auto-fit, minmax(N, 1fr))` with 12–16px gap — N is 150px (swatches), 230–280px (cards), 300px (two-up panels).
Header: 40px lockup, 52px title, 17px intro (max 62ch, `text-wrap: pretty`), audience chips (Mono 12px, 1px border, radius 4px, padding 5px 10px).
Footer: 1px top border, 28px padding-top, version string left (Mono 12px) and system summary right (13px).

### 2. Query console — in product (dark)
Purpose: the working screen. Frame: radius 12px, border `#232A36`, bg `#0B0E14`, overflow hidden.

**Top bar** (bg `#11151D`, 1px bottom border `#232A36`, padding 12px 16px, space-between):
left — 20px symbol + `dbportal` Mono 14px/600 + 8px extra left margin then datasource path `prod-eu-west-1 / orders` Mono 12px `#9AA5B2`;
right — write-window countdown chip (Mono 12px, text `#F0C476`, bg `#2A2113`, border `#4A3A1C`, radius 4px, padding 4px 9px) + 26px round avatar, bg `#1F6FEB`, initials 11px/600 white.

**Body**: CSS grid `minmax(0,1.7fr) minmax(0,1fr)`, 1px divider between.

Left column, top to bottom:
1. *Editor* — padding 18px 20px, Mono 13.5px, lh 1.75. Keywords `#4E96FF`, literals/strings `#7FD3AC`, identifiers `#E8ECF1`.
2. *Run bar* — bg `#11151D`, 1px top+bottom border, padding 10px 20px, 10px gap: primary Run button, then result meta `50 rows · 41 ms · logged as mrocha@corp` in Mono 12px `#9AA5B2`. **The identity of the executor is always on the run bar** — it is not optional chrome.
3. *Result table* — grid `70px 1fr 1fr`, 12px gap, padding 9px 20px per row, header row Mono 12.5px `#9AA5B2` ls 0.05em with 1px bottom border `#232A36`; data rows separated by `#1A202A`. Status cells use the dark status colors. PII columns render masked (`•••••@corp.com`) in `#9AA5B2`.

Right column — *Audit rail* (bg `#0E121A`), always visible, never a separate page:
header `AUDIT RAIL` Mono 11px ls 0.06em `#9AA5B2`, 1px bottom border; entries padding 12px 18px, 4px column gap, 1px `#1A202A` separators. Each entry = line 1 Mono 12px `HH:MM:SS · VERB · outcome` colored by outcome (`#7FD3AC` / `#F0C476` / `#E9807B` / `#9AA5B2` for session events), line 2 Sans 12.5px `#A7B1BE` with actor and the reason (role, reviewer, or policy name).

---

## Interactions & Behavior
- **Buttons**: hover per table above; instant, no transition longer than 120ms ease-out if the codebase animates.
- **Input focus**: border color change + 2px `#CFE0FD` outline. Never remove the outline.
- **Run**: `⌘↵` executes. While running, primary button shows a disabled state; the run bar meta is replaced by an elapsed counter. On completion the audit rail prepends a new entry.
- **Write window**: the countdown chip is live (mm:ss). At 00:00 write statements are refused and the chip turns to the denied palette.
- **Approval flow**: a write statement without standing permission does not execute — it enters `awaiting approval`, the result area shows the pending state, and the audit entry records the reviewer.
- **Masking**: PII columns are masked by default; unmasking is itself an audited action.
- **Responsive**: the reference page is fluid (auto-fit grids). The console grid collapses to a single column below ~900px with the audit rail moving below the results.

## State Management
- `session`: user, SSO provider, MFA state, roles, write-window expiry timestamp.
- `datasource`: selected environment + database, permission level (`read-only` | `write` | `none`).
- `editor`: query text, dirty flag.
- `execution`: `idle` | `running` | `succeeded` | `awaiting_approval` | `denied`; row count, duration, error/policy reason.
- `results`: columns (with `masked` flag), rows, truncation notice.
- `audit`: append-only list, newest first, streamed/polled — it must reflect other users' actions on the same datasource, not just this session's.
- Data: datasource list + permissions on session start; execution POST returns either results or a policy decision; audit via stream or short poll.

## Assets
No image assets. The logo is inline SVG (paths above). Fonts come from Google Fonts (IBM Plex Sans / IBM Plex Mono, OFL) — self-host in production. Any icons beyond the logo should come from the target codebase's existing icon set, drawn at 1.5–2px stroke to match the mark.
