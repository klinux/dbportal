import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const theme = readFileSync(join(ROOT, "src", "styles", "theme.css"), "utf8");
const globals = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");

/** Prose in this file talks ABOUT tokens; only declarations may be counted. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside one top-level block, by selector. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

function declaredIn(selector: string): Set<string> {
  const body = block(stripComments(theme), selector);
  return new Set(Array.from(body.matchAll(/(--studio-[a-z0-9-]+)\s*:/g), (m) => m[1]));
}

const light = declaredIn(":root");
const dark = declaredIn(".dark");

/**
 * A token missing from one palette does not fall back to the other — it resolves
 * to nothing, which is invalid at computed-value time. The failure is silent and
 * mode-specific: a ground drops to transparent, a hairline to `currentColor`, and
 * only in the theme nobody happened to be looking at. So the two palettes are
 * checked as sets, not spot-checked.
 */
describe("the two palettes cover the same tokens", () => {
  test("every light token has a dark value", () => {
    expect([...light].filter((token) => !dark.has(token))).toEqual([]);
  });

  test("every dark token has a light value", () => {
    expect([...dark].filter((token) => !light.has(token))).toEqual([]);
  });

  test("the palettes are not empty (the block parse actually found declarations)", () => {
    expect(light.size).toBeGreaterThan(15);
  });
});

describe("every token reference resolves to a declaration", () => {
  /**
   * `@theme inline` is what turns a token into a Tailwind utility. A mapping
   * pointing at a name no palette declares compiles fine and emits a utility that
   * colours nothing.
   */
  test("the @theme mapping points only at declared tokens", () => {
    const mapping = block(stripComments(theme), "@theme inline");
    const referenced = Array.from(mapping.matchAll(/var\((--studio-[a-z0-9-]+)\)/g), (m) => m[1]);
    expect(referenced.length).toBeGreaterThan(15);
    expect(referenced.filter((token) => !light.has(token))).toEqual([]);
  });

  /**
   * globals.css reaches for the tokens directly in the rules Tailwind cannot
   * express (`.glass-panel`, the editor scrollbar). Those references are just as
   * silent when they miss.
   */
  test("globals.css references only declared tokens", () => {
    const referenced = Array.from(stripComments(globals).matchAll(/var\((--studio-[a-z0-9-]+)\)/g), (m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((token) => !light.has(token))).toEqual([]);
  });

  test("globals.css imports the token layer, so standalone studio gets it too", () => {
    expect(globals).toContain('@import "../styles/theme.css"');
  });
});

/**
 * The dark palette is docs/DESIGN.md's (docs/CONTEXT.md §5, rebrand layer 3): the app
 * background and editor ground, the top bar, the two structural borders and the three text
 * steps it names. Pinned by value so a retune of one theme is a decision somebody made,
 * not a side effect of editing the other.
 */
describe("the dark palette is the handoff's", () => {
  const value = (token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(block(stripComments(theme), ".dark"))?.[1];

  test("the surface ramp", () => {
    expect(value("--studio-canvas")).toBe("#0b0e14");
    expect(value("--studio-surface")).toBe("#0e121a");
    expect(value("--studio-panel")).toBe("rgb(14 18 26 / 0.6)");
  });

  test("the hairlines are the two structural borders", () => {
    expect(value("--studio-hairline")).toBe("#1a202a");
    expect(value("--studio-hairline-strong")).toBe("#232a36");
  });

  test("the text ramp", () => {
    expect(value("--studio-fg")).toBe("#e8ecf1");
    expect(value("--studio-fg-tertiary")).toBe("#a7b1be");
    expect(value("--studio-fg-muted")).toBe("#9aa5b2");
  });

  /**
   * Its own pair, off the text ramp: a chrome detail routed through the ramp once
   * became the brightest thing on a quiet panel.
   */
  test("the editor scrollbar stays a chrome detail", () => {
    expect(value("--studio-scrollbar")).toBe("#2a3340");
    expect(value("--studio-scrollbar-hover")).toBe("#3c4655");
  });
});
