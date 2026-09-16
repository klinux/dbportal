#!/usr/bin/env node
/**
 * The repository's markdown, adapted for Starlight (docs/CONTEXT.md §4.51). Reads docs/**,
 * README.md and SECURITY.md; writes src/content/docs with a frontmatter title taken from
 * each page's first heading, the links between documents rewritten to site paths, the
 * links into the source tree rewritten to GitHub, the screenshots and the brand marks
 * staged under public/. The markdown in the repository stays the source of truth: this
 * output is generated on every build and never committed.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(WEBSITE, "..");
const OUT = path.join(WEBSITE, "src", "content", "docs");
const PUBLIC = path.join(WEBSITE, "public");
const BASE = "/dbportal";
const REPO = "https://github.com/klinux/dbportal/blob/main/";

/** Where a repository file lands on the site: [directory, slug]; index pages take the directory. */
const GUIDES = {
  "docs/OPERATOR_GUIDE.md": 1,
  "docs/SEED_CONNECTIONS.md": 2,
  "docs/HELM_CHART.md": 3,
  "docs/STORAGE.md": 4,
  "docs/OIDC.md": 5,
  "docs/MFA.md": 6,
  "SECURITY.md": 7,
  "docs/SUBPATH.md": 8,
  "docs/TOOLCHAIN.md": 9,
};
const REFERENCE = {
  "docs/API_DOCS.md": 1,
  "docs/ARCHITECTURE.md": 2,
  "docs/FEATURES.md": 3,
  "docs/DATABASE_PROVIDERS.md": 4,
  "docs/SCHEMA_DIFF.md": 5,
  "docs/ADDING_A_PROVIDER.md": 6,
  "docs/THIRD_PARTY_LICENSES.md": 99,
};

function slugOf(name) {
  return name
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The site path (directory + file) of a repository markdown file, or null to leave it out. */
function place(rel) {
  if (rel === "README.md") return { dir: "", file: "index.md", order: 0 };
  if (rel in GUIDES) return { dir: "guides", file: `${slugOf(path.basename(rel))}.md`, order: GUIDES[rel] };
  if (rel in REFERENCE) return { dir: "reference", file: `${slugOf(path.basename(rel))}.md`, order: REFERENCE[rel] };
  if (rel === "docs/CONTEXT.md") return { dir: "project", file: "context.md", order: 1 };
  if (rel === "docs/DESIGN.md") return { dir: "design", file: "design.md", order: 1 };
  const under = (prefix, dir) => {
    if (!rel.startsWith(prefix)) return null;
    const rest = rel.slice(prefix.length);
    const parts = rest.split("/").map((p, i, all) => (i === all.length - 1 ? p : slugOf(p)));
    const base = parts.pop();
    const file = /^readme\.md$/i.test(base) ? "index.md" : `${slugOf(base)}.md`;
    return { dir: [dir, ...parts].filter(Boolean).join("/"), file };
  };
  return (
    under("docs/providers/", "providers") ??
    under("docs/editor/", "editor") ??
    under("docs/llms/", "llms") ??
    under("docs/ui/", "design/ui") ??
    (rel.startsWith("docs/AGENT") ? { dir: "agent", file: `${slugOf(path.basename(rel))}.md` } : null) ??
    (rel.startsWith("docs/") && !rel.includes("/") === false && rel.split("/").length === 2
      ? { dir: "reference", file: `${slugOf(path.basename(rel))}.md`, order: 50 }
      : null)
  );
}

function siteUrl(placed) {
  const dir = placed.dir ? `/${placed.dir}` : "";
  const page = placed.file === "index.md" ? "" : `/${placed.file.replace(/\.md$/, "")}`;
  return `${BASE}${dir}${page}/`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

// 1. Every page and where it lands, so links can be resolved before anything is written.
const sources = ["README.md", "SECURITY.md", ...walk(path.join(ROOT, "docs")).map((f) => path.relative(ROOT, f))];
const pages = new Map();
for (const rel of sources) {
  const placed = place(rel);
  if (placed) pages.set(rel, placed);
}

/** A link target as the page wrote it, resolved to where it points on the site or on GitHub. */
function rewriteTarget(target, fromRel) {
  if (/^(https?:|mailto:|#|\/|data:)/i.test(target) || target.startsWith("{")) return target;
  const [pathPart, anchor = ""] = target.split(/(?=#)/);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), pathPart));
  const page = pages.get(resolved);
  if (page) return siteUrl(page) + anchor;
  if (resolved.startsWith("docs/screenshots/")) return `${BASE}/screenshots/${path.posix.basename(resolved)}`;
  if (resolved.startsWith("public/brand/")) return `${BASE}/brand/${path.posix.basename(resolved)}`;
  return `${REPO}${resolved}${anchor}`;
}

function rewriteLinks(body, fromRel) {
  return body
    .replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, target, title) => `](${rewriteTarget(target, fromRel)}${title ?? ""})`)
    .replace(/\b(src|href|srcset)="([^"]+)"/g, (m, attr, target) => `${attr}="${rewriteTarget(target, fromRel)}"`);
}

function escapeYaml(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The first heading as the page's title, taken off the body so Starlight does not print it twice. */
function splitTitle(body, rel) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (m && rel !== "README.md") {
    const title = m[1].replace(/`/g, "").replace(/\s*[—-]\s*.*$/, (x) => (x.length > 40 ? "" : x));
    return { title, body: body.replace(m[0], "").replace(/^\s*\n/, "") };
  }
  if (rel === "README.md") return { title: "dbportal", body };
  return { title: slugOf(path.basename(rel)).replace(/-/g, " "), body };
}

// 2. Write every page.
rmSync(OUT, { recursive: true, force: true });
for (const [rel, placed] of pages) {
  const raw = readFileSync(path.join(ROOT, rel), "utf8");
  const { title, body } = splitTitle(raw, rel);
  const front = [
    "---",
    `title: ${escapeYaml(title)}`,
    ...(placed.order !== undefined ? [`sidebar:`, `  order: ${placed.order}`] : []),
    ...(rel === "README.md" ? ["tableOfContents: false"] : []),
    "---",
    "",
  ].join("\n");
  const target = path.join(OUT, placed.dir, placed.file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, front + rewriteLinks(body, rel));
}

// 3. The images the pages reach for.
rmSync(path.join(PUBLIC, "screenshots"), { recursive: true, force: true });
rmSync(path.join(PUBLIC, "brand"), { recursive: true, force: true });
cpSync(path.join(ROOT, "docs", "screenshots"), path.join(PUBLIC, "screenshots"), { recursive: true });
cpSync(path.join(ROOT, "public", "brand"), path.join(PUBLIC, "brand"), { recursive: true });

console.log(`sync-docs: ${pages.size} pages written to ${path.relative(WEBSITE, OUT)}`);
