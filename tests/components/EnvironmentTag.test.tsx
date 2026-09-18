/**
 * The environment beside a datasource's name in every picker (docs/CONTEXT.md §4.36): the
 * same application lives in several environments under one name, and a picker showing
 * name and engine alone shows identical rows. Seen on a deployment 2026-09-18 with two
 * `smb (mysql)` rows in the operations picker.
 */
import "../setup-dom";
import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { EnvironmentTag, environmentLabel, environmentSuffix } from "@/components/EnvironmentTag";
import type { Environment } from "@/lib/types";

const declared: Environment[] = [
  { id: "production", label: "PROD", color: "#ef4444", order: 0 },
  { id: "dr", label: "DR SITE", color: "#0ea5e9", order: 1 },
];

describe("EnvironmentTag", () => {
  afterEach(cleanup);

  test("draws the environment's label in its colour, and nothing for other or none", () => {
    const { getByTestId, rerender, queryByTestId } = render(<EnvironmentTag environment="production" />);
    expect(getByTestId("environment-tag").textContent).toBe("PROD");
    expect(getByTestId("environment-tag").getAttribute("style")).toContain("#ef4444");
    rerender(<EnvironmentTag environment="staging" className="ml-2" />);
    expect(getByTestId("environment-tag").textContent).toBe("STAGING");
    expect(getByTestId("environment-tag").className).toContain("ml-2");
    rerender(<EnvironmentTag environment="other" />);
    expect(queryByTestId("environment-tag")).toBeNull();
    rerender(<EnvironmentTag />);
    expect(queryByTestId("environment-tag")).toBeNull();
  });

  // The server's list when the caller has it: a declared environment by its label, one the
  // list lacks under its own id rather than hidden.
  test("uses the caller's list, and names an unknown environment by its id", () => {
    const { getByTestId, rerender } = render(<EnvironmentTag environment="dr" environments={declared} />);
    expect(getByTestId("environment-tag").textContent).toBe("DR SITE");
    rerender(<EnvironmentTag environment="sandbox" environments={declared} />);
    expect(getByTestId("environment-tag").textContent).toBe("SANDBOX");
  });

  test("the suffix for a plain option is the label after a dot, or nothing", () => {
    expect(environmentLabel("production")).toBe("PROD");
    expect(environmentLabel(undefined)).toBe("");
    expect(environmentSuffix("staging")).toBe(" · STAGING");
    expect(environmentSuffix("dr", declared)).toBe(" · DR SITE");
    expect(environmentSuffix("other")).toBe("");
    expect(environmentSuffix(undefined)).toBe("");
  });
});
