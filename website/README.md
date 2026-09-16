# Documentation site

The repository's `docs/*.md`, rendered with [Starlight](https://starlight.astro.build) and
published on GitHub Pages at <https://klinux.github.io/dbportal/> by
`.github/workflows/docs.yml` on every push to `main` that touches the docs or this folder.

Nothing here duplicates the docs: `scripts/sync-docs.mjs` copies them into
`src/content/docs` at build time, takes each page's title from its first heading, rewrites
the links between documents to site paths and the links into the source tree to GitHub, and
stages the screenshots. Edit the markdown under `docs/`, not the generated copy.

```bash
cd website
bun install
bun run dev      # http://localhost:4321/dbportal/
bun run build    # dist/
```
