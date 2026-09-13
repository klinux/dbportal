import { describe, test, expect } from "bun:test";
import { APPLICATION_NAME_MAX_LENGTH, applicationNameFor } from "@/lib/db/application-name";

/**
 * The label a person's pool carries into the engine (docs/CONTEXT.md §4.3). The engine's
 * own session views are the second audit trail, so the label has to survive what the
 * engines do to it: PostgreSQL truncates at 63 and replaces non-ASCII with `?`.
 */
describe("applicationNameFor", () => {
  test("names the person and where the session came from", () => {
    expect(applicationNameFor("ana@example.test")).toBe("ana@example.test@dbportal");
  });

  test("keeps the marker when the username is long: the username loses its tail, not the suffix", () => {
    const name = applicationNameFor(`${"x".repeat(80)}@example.test`);
    expect(name.length).toBe(APPLICATION_NAME_MAX_LENGTH);
    expect(name.endsWith("@dbportal")).toBe(true);
  });

  test("replaces what the engine would replace, so the record reads the same on both sides", () => {
    expect(applicationNameFor("josé")).toBe("jos??@dbportal");
  });
});
