/**
 * The account routes' shared reading of the body and answering of a refusal.
 */
import { describe, expect, test } from "bun:test";
import { answerProvisionError, readAccountRequest } from "@/lib/api/provisioning";
import { ProvisionError } from "@/lib/provisioning/errors";
import { VaultError } from "@/lib/vault/client";

describe("readAccountRequest", () => {
  test("reads the profile, the schemas de-duplicated, the agent flag, the bootstrap and the mount", () => {
    expect(
      readAccountRequest({
        profile: "readwrite",
        schemas: ["sales", "sales", "public"],
        agent: true,
        bootstrap: { user: " dba ", password: "s" },
        vaultMount: " kv ",
      }),
    ).toEqual({
      request: { profile: "readwrite", schemas: ["sales", "public"], agent: true },
      bootstrap: { user: "dba", password: "s" },
      vaultMount: "kv",
    });
  });

  test("defaults what was left out: no schemas, no agent, no bootstrap, no mount", () => {
    expect(readAccountRequest({ profile: "read", bootstrap: null, vaultMount: "" })).toEqual({
      request: { profile: "read", schemas: [], agent: false },
      bootstrap: undefined,
      vaultMount: undefined,
    });
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["a missing profile", {}, "profile must be"],
    ["an unknown profile", { profile: "owner" }, "profile must be"],
    ["schemas that are not a list", { profile: "read", schemas: "sales" }, "schemas must be a list"],
    ["too many schemas", { profile: "read", schemas: Array.from({ length: 101 }, (_, i) => `s${i}`) }, "at most 100"],
    ["a schema that is not a name", { profile: "read", schemas: ["ok", 3] }, "schema names"],
    ["a schema with a control character", { profile: "read", schemas: ["bad\nname"] }, "schema names"],
    ["a schema past 63 characters", { profile: "read", schemas: ["x".repeat(64)] }, "schema names"],
    ["a bootstrap that is not an object", { profile: "read", bootstrap: "dba" }, "bootstrap must be an object"],
    ["a bootstrap that is a list", { profile: "read", bootstrap: ["dba"] }, "bootstrap must be an object"],
    ["a bootstrap without a password", { profile: "read", bootstrap: { user: "dba", password: "" } }, "needs a user and a password"],
    ["a bootstrap without a user", { profile: "read", bootstrap: { user: "  ", password: "s" } }, "needs a user and a password"],
  ])("refuses %s", (_label, body, message) => {
    const err = (() => {
      try {
        readAccountRequest(body);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).statusCode).toBe(400);
    expect((err as ProvisionError).message).toContain(message);
  });
});

describe("answerProvisionError", () => {
  test("answers a refusal with its status, a Vault failure as 502, and anything else as an anonymous 500", async () => {
    const refused = answerProvisionError(new ProvisionError("no", 409), "route");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no" });

    const vault = answerProvisionError(new VaultError("Vault answered 403 for x", 403), "route");
    expect(vault.status).toBe(502);

    const bug = answerProvisionError(new TypeError("secret detail"), "route");
    expect(bug.status).toBe(500);
    expect(await bug.json()).toEqual({ error: "Account provisioning failed" });
  });
});
