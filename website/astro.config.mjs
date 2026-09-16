// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

/**
 * The documentation site (docs/CONTEXT.md §4.51): the repository's docs/*.md, copied and
 * adapted by scripts/sync-docs.mjs into src/content/docs at build time, rendered with
 * Starlight and published on GitHub Pages under /dbportal. Nothing is written by hand here
 * that also lives in docs/ - the markdown in the repository stays the source of truth.
 */
export default defineConfig({
  site: "https://klinux.github.io",
  base: "/dbportal",
  integrations: [
    starlight({
      title: "dbportal",
      description: "A shared database portal: datasources declared once, single sign-on, every execution attributed to a person.",
      logo: { light: "./public/brand/lockup.svg", dark: "./public/brand/lockup-dark.svg", replacesTitle: true },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/klinux/dbportal" }],
      editLink: { baseUrl: "https://github.com/klinux/dbportal/edit/main/" },
      customCss: ["./src/styles/custom.css"],
      // The docs fence .env examples as ```env; Shiki knows that grammar as dotenv.
      expressiveCode: { shiki: { langAlias: { env: "dotenv" } } },
      sidebar: [
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Database providers", items: [{ autogenerate: { directory: "providers" } }] },
        { label: "Agent", items: [{ autogenerate: { directory: "agent" } }] },
        { label: "Editor", items: [{ autogenerate: { directory: "editor" } }] },
        { label: "Models", collapsed: true, items: [{ autogenerate: { directory: "llms" } }] },
        { label: "Design", items: [{ autogenerate: { directory: "design" } }] },
        { label: "Project", items: [{ autogenerate: { directory: "project" } }] },
      ],
    }),
  ],
});
