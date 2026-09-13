import "../../setup-dom";
import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * Every engine icon the connection picker can show, rendered once.
 *
 * Until the rebrand the login hero listed every engine, so each mark in
 * `src/components/icons/db-icons.tsx` was rendered by the login tests as a side effect.
 * That hero is gone; this is the one place that now draws the whole set, so an icon
 * whose SVG stops rendering - or a new engine whose icon is never wired - fails here
 * rather than on the first user who scrolls to it.
 */
describe("db-icons", () => {
  afterEach(() => {
    cleanup();
  });

  test("every configured engine renders an svg that inherits the caller's className", () => {
    for (const type of Object.keys(DB_UI_CONFIG) as DatabaseType[]) {
      const Icon = DB_UI_CONFIG[type].icon;
      const { container, unmount } = render(<Icon className="probe-class" />);
      const svg = container.querySelector("svg");
      expect(svg, type).not.toBeNull();
      expect(svg!.getAttribute("class"), type).toContain("probe-class");
      unmount();
    }
  });
});
