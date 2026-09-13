import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { GitHubRepoLink } from "@/components/github-repo-link";

describe("GitHubRepoLink", () => {
  afterEach(() => {
    cleanup();
  });

  test("links to the repository in a new tab, with an accessible name", () => {
    const { container } = render(<GitHubRepoLink />);
    const link = container.querySelector("a");

    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://github.com/klinux/dbportal");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link!.getAttribute("aria-label")).toBe("dbportal on GitHub");
    // An icon-only link must never be announced as a button (jsx-a11y gate).
    expect(link!.getAttribute("role")).toBeNull();
  });

  /**
   * The mark is inlined rather than imported: lucide-react 1.x dropped every
   * brand icon, so the octocat now lives in this component. It must stay hidden
   * from assistive technology - the anchor's aria-label is the accessible name -
   * and must paint with `currentColor` so the caller keeps owning the colour.
   */
  test("renders the GitHub mark inline, hidden from assistive technology", () => {
    const { container } = render(<GitHubRepoLink />);
    const svg = container.querySelector("a > svg");

    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("fill")).toBe("currentColor");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.getAttribute("class")).toContain("w-3.5");
    expect(svg!.getAttribute("class")).toContain("h-3.5");
    // The real octocat mark, not an approximation. Pinning both ends of the path
    // is what makes this an assertion: a length check passes against any 200-odd
    // characters of invented or truncated data, which is the exact failure mode
    // of hand-inlining an SVG - a malformed path renders a blob and no gate sees it.
    const paths = svg!.querySelectorAll("path");
    expect(paths.length).toBe(1);
    const d = paths[0]!.getAttribute("d")!;
    expect(d.startsWith("M12 .297c-6.63 0-12 5.373-12 12")).toBe(true);
    expect(d.endsWith("0-6.627-5.373-12-12-12")).toBe(true);
    // Filled, never stroked: the mark is a solid glyph, unlike the lucide
    // outline icons it sits beside.
    expect(svg!.getAttribute("stroke")).toBeNull();
  });

  /**
   * The caller owns spacing, sizing AND colour: this link sits in fixed dark
   * chrome (the studio headers) and in theme-token chrome (the sidebar), and
   * merging two competing text colours here would rely on tailwind-merge
   * resolving a custom token, which it silently does not.
   */
  test("keeps the caller's own spacing and colour", () => {
    const { container } = render(<GitHubRepoLink className="mx-2 text-zinc-400 hover:text-white" />);
    const link = container.querySelector("a")!;

    expect(link.className).toContain("mx-2");
    expect(link.className).toContain("text-zinc-400");
    expect(link.className).toContain("hover:text-white");
    expect(link.className).toContain("transition-colors");
  });
});
