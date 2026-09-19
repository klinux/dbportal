import { describe, test, expect, mock } from "bun:test";
import { objectRefusal } from "@/lib/objects/gate";
import { UNRESTRICTED, type ObjectScope } from "@/lib/objects/rules";

/**
 * The refusal a scope gives a statement (docs/CONTEXT.md §4.56): the first name outside
 * the scope, with the fix the person can apply, and nothing for engines whose query
 * language is not SQL.
 */
const scope: ObjectScope = { restricted: true, patterns: ["orders", "public.cust*"] };

function gate(statements: string[], overrides: Partial<Parameters<typeof objectRefusal>[0]> = {}) {
  return objectRefusal({
    scope,
    statements,
    type: "postgres",
    datasourceName: "Orders",
    depth: 1,
    defaultContainer: async () => ["public"],
    ...overrides,
  });
}

describe("objectRefusal", () => {
  test("unrestricted, or an engine that does not read SQL text: nothing to refuse", async () => {
    expect(await gate(["SELECT * FROM secret"], { scope: UNRESTRICTED })).toBeNull();
    // The rules filter what a MongoDB datasource shows; its commands are not judged here.
    expect(await gate(["db.secret.find()"], { type: "mongodb" })).toBeNull();
  });

  test("every statement inside the scope passes, and the default container is read once", async () => {
    const defaultContainer = mock(async () => ["public"]);
    expect(await gate(["SELECT * FROM orders", "SELECT * FROM customers c JOIN customers_archive a ON 1=1"], { defaultContainer })).toBeNull();
    expect(defaultContainer).toHaveBeenCalledTimes(1);
  });

  test("the default container is not read when no name needs it", async () => {
    const defaultContainer = mock(async () => ["public"]);
    expect(await gate(["SELECT * FROM public.customers"], { defaultContainer })).toBeNull();
    expect(await gate(["SELECT * FROM orders"], { defaultContainer, scope: { restricted: true, patterns: ["orders"] } })).toBeNull();
    expect(defaultContainer).toHaveBeenCalledTimes(0);
  });

  test("a statement it cannot read is refused with the keyword", async () => {
    expect(await gate(["SELECT 1", "CALL hidden()"])).toBe(
      '"Orders" limits which objects you may use, and a CALL statement cannot be checked for the objects it reaches. ' +
        "Write it as a statement that names its tables, or ask an administrator.",
    );
  });

  test("a hidden object names the refusal; a wildcard and an unplaceable name say what to do", async () => {
    expect(await gate(["SELECT * FROM public.invoices"])).toBe('"public.invoices" is not an object you may use on "Orders".');
    expect(await gate(["SELECT * FROM public.*"])).toBe(
      '"public.*" names objects by pattern; on "Orders" name each object you mean, so each can be checked.',
    );
    expect(await gate(["SELECT * FROM customers"], { defaultContainer: async () => undefined })).toBe(
      'Qualify "customers" with its schema: "Orders" limits objects by schema and the session\'s default schema is not known here.',
    );
  });
});
