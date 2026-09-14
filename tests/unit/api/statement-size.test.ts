import { describe, test, expect } from "bun:test";
import { SQL_MAX_CHARS, statementTooLarge } from "@/lib/api/statement-size";

/** The one bound on statement text a request may carry (docs/CONTEXT.md §4.21): a 413 above it, nothing below. */
describe("statementTooLarge", () => {
  test("answers null up to the bound and a 413 that names both sizes above it", async () => {
    expect(statementTooLarge("x".repeat(SQL_MAX_CHARS))).toBeNull();
    const res = statementTooLarge("x".repeat(SQL_MAX_CHARS + 1));
    expect(res?.status).toBe(413);
    expect((await res!.json()).error).toContain(`${SQL_MAX_CHARS + 1} characters`);
  });
});
