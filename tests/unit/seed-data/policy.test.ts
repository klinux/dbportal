/**
 * The one rule for generating rows into a datasource.
 *
 * The admin's seed panel and the studio's "Generate Test Data" row action used to decide
 * separately, and the studio decided nothing: it offered the action on a production
 * datasource the admin panel refused to seed. Both now import this rule, and these tests
 * pin the two refusals and the shared sentence.
 */
import { describe, expect, test } from "bun:test";
import { PRODUCTION_SEED_REFUSAL, testDataRefusal } from "@/lib/seed-data/policy";
import { seedAllowed } from "@/lib/seed-data/run";

describe("testDataRefusal", () => {
  test("allows a writable datasource outside production", () => {
    expect(testDataRefusal({ environment: "staging" })).toBeNull();
    expect(testDataRefusal({ environment: "development", readOnly: false })).toBeNull();
    // An environment left undeclared is not production.
    expect(testDataRefusal({})).toBeNull();
  });

  test("refuses a production datasource in the admin panel's own words", () => {
    expect(testDataRefusal({ environment: "production" })).toBe(PRODUCTION_SEED_REFUSAL);
    expect(seedAllowed({ type: "postgres", environment: "production" })).toBe(PRODUCTION_SEED_REFUSAL);
  });

  test("refuses a session the server decided may not write", () => {
    expect(testDataRefusal({ environment: "staging", readOnly: true })).toContain("may not write");
  });

  // Production wins over read-only: the sentence names the stronger reason.
  test("names production first when both apply", () => {
    expect(testDataRefusal({ environment: "production", readOnly: true })).toBe(PRODUCTION_SEED_REFUSAL);
  });

  test("refuses when no datasource is open at all", () => {
    expect(testDataRefusal(null)).toBe("No datasource is open");
    expect(testDataRefusal(undefined)).toBe("No datasource is open");
  });
});
