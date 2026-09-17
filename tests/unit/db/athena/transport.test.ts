/**
 * Athena transport seam
 *
 * Almost all of transport.ts is type declarations, which erase at build time. What
 * survives is what every other file switches on: the two service constants and the
 * normalized error, whose `instanceof` is the only thing the provider's mapping
 * relies on - which is why the prototype fix-up is asserted rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import {
  ATHENA_DEFAULT_CATALOG,
  ATHENA_DEFAULT_WORKGROUP,
  ATHENA_DISPLAY_NAME,
  type AthenaErrorCategory,
  AthenaTransportError,
} from "@/lib/db/providers/sql/athena/transport";

describe("the service constants", () => {
  // The Glue Data Catalog of the account and region is what the service calls
  // `AwsDataCatalog`, and every metadata call names a catalog explicitly.
  test("name the default catalog and the workgroup every account has", () => {
    expect(ATHENA_DEFAULT_CATALOG).toBe("AwsDataCatalog");
    expect(ATHENA_DEFAULT_WORKGROUP).toBe("primary");
    expect(ATHENA_DISPLAY_NAME).toBe("Athena");
  });
});

describe("AthenaTransportError", () => {
  test("carries the category, the message and the fault name", () => {
    const error = new AthenaTransportError(
      "syntax",
      "SYNTAX_ERROR: line 1:1: mismatched input 'SELEKT'",
      "SYNTAX_ERROR",
    );

    expect(error.category).toBe("syntax");
    expect(error.message).toBe("SYNTAX_ERROR: line 1:1: mismatched input 'SELEKT'");
    expect(error.code).toBe("SYNTAX_ERROR");
    expect(error.name).toBe("AthenaTransportError");
  });

  test("defaults the fault name to null when the failure carried none", () => {
    expect(new AthenaTransportError("unreachable", "no route").code).toBeNull();
  });

  // Subclassing a builtin loses the prototype under a downlevel emit, and every
  // `instanceof` in the provider would then fall through to the generic mapping.
  test("survives instanceof, which is what the provider's mapping switches on", () => {
    const error: unknown = new AthenaTransportError("auth", "refused");

    expect(error).toBeInstanceOf(AthenaTransportError);
    expect(error).toBeInstanceOf(Error);
  });

  test("every category is a distinct word the provider can branch on", () => {
    const categories: AthenaErrorCategory[] = [
      "syntax",
      "unknown-object",
      "unsupported",
      "auth",
      "unreachable",
      "cancelled",
      "timeout",
      "resources",
      "engine",
    ];

    expect(new Set(categories).size).toBe(categories.length);
  });
});
