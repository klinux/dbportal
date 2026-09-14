/**
 * The chart's `role` value (docs/CONTEXT.md §4.30): a default render writes no
 * DBPORTAL_ROLE, so a studio release is what it always was; `role: agent` writes the one
 * variable that turns the same image into the surface programs call; anything else is
 * refused by the values schema. Exercises real `helm template` output.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/dbportal");
const JWT = "0123456789abcdef0123456789abcdef";

function render(...sets: string[]): { name: string; value?: string }[] {
  const args = ["template", "t", CHART_DIR, "--set", `secrets.jwtSecret=${JWT}`, ...sets.flatMap((s) => ["--set", s])];
  const out = execFileSync("helm", args, { encoding: "utf8" });
  const deployment = parseAllDocuments(out)
    .map((d) => d.toJSON())
    .find((d) => d?.kind === "Deployment");
  return deployment.spec.template.spec.containers[0].env;
}

describe("helm chart: role", () => {
  test("a default render writes no DBPORTAL_ROLE; role=agent writes it; another word fails the schema", () => {
    expect(render().find((e) => e.name === "DBPORTAL_ROLE")).toBeUndefined();
    expect(render("role=agent").find((e) => e.name === "DBPORTAL_ROLE")).toEqual({
      name: "DBPORTAL_ROLE",
      value: "agent",
    });
    expect(() => render("role=worker")).toThrow();
  });
});
