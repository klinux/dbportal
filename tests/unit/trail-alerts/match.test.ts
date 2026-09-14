import { describe, test, expect } from "bun:test";
import { describeTrailEvent, ruleFor } from "@/lib/trail-alerts/match";

/** Which event trips which rule (docs/CONTEXT.md §4.32), and how each is told. */
const env = (name: string) => (name === "Prod" ? "production" : name === "Stage" ? "staging" : undefined);
const config = { exportRowsThreshold: 100 };

describe("trail alerts match", () => {
  test("a guardrail denial, a large production export, a failed backup and a failed seed; nothing else", () => {
    expect(
      ruleFor({ type: "permission_denied", action: "denied", result: "failure", reason: "guardrail" }, config, env),
    ).toBe("guardrail");
    expect(
      ruleFor({ type: "permission_denied", action: "denied", result: "failure", reason: "no_session" }, config, env),
    ).toBeNull();
    expect(
      ruleFor(
        { type: "data_export", action: "csv", result: "success", rows: 100, connectionName: "Prod" },
        config,
        env,
      ),
    ).toBe("production_export");
    expect(
      ruleFor({ type: "data_export", action: "csv", result: "success", rows: 99, connectionName: "Prod" }, config, env),
    ).toBeNull();
    expect(
      ruleFor(
        { type: "data_export", action: "csv", result: "success", rows: 500, connectionName: "Stage" },
        config,
        env,
      ),
    ).toBeNull();
    expect(
      ruleFor(
        { type: "data_export", action: "csv", result: "success", rows: 500, connectionName: "Ghost" },
        config,
        env,
      ),
    ).toBeNull();
    expect(ruleFor({ type: "data_export", action: "csv", result: "success", rows: 500 }, config, env)).toBeNull();
    expect(
      ruleFor(
        { type: "data_export", action: "csv", result: "failure", rows: 500, connectionName: "Prod" },
        config,
        env,
      ),
    ).toBeNull();
    expect(ruleFor({ type: "backup", action: "created", result: "failure" }, config, env)).toBe("backup_failed");
    expect(ruleFor({ type: "backup", action: "created", result: "success" }, config, env)).toBeNull();
    expect(ruleFor({ type: "data_seed", action: "failed", result: "failure" }, config, env)).toBe("seed_failed");
    expect(ruleFor({ type: "data_seed", action: "finished", result: "success" }, config, env)).toBeNull();
    expect(ruleFor({ type: "alert", action: "fired", result: "success" }, config, env)).toBeNull();
  });

  test("the message names the person and what happened, never a statement", () => {
    expect(describeTrailEvent("guardrail", { action: "denied", user: "ana", target: "POST /api/db/query" })).toBe(
      "ana was stopped by a guardrail on POST /api/db/query",
    );
    expect(describeTrailEvent("production_export", { action: "csv", user: "ana", target: "x", rows: 5000 })).toBe(
      "ana exported 5000 rows as csv",
    );
    expect(describeTrailEvent("production_export", { action: "csv", user: "ana", target: "x" })).toBe(
      "ana exported 0 rows as csv",
    );
    expect(describeTrailEvent("backup_failed", { action: "restored", user: "root", target: "orders" })).toBe(
      "backup restored by root failed",
    );
    expect(describeTrailEvent("seed_failed", { action: "failed", user: "root", target: "stage" })).toBe(
      "seed run by root failed",
    );
  });
});
