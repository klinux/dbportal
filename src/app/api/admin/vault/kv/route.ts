import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { VaultError, isVaultConfigured } from "@/lib/vault/client";
import { browseKv, secretFields } from "@/lib/vault/kv-browser";

/**
 * The Vault KV browser (docs/CONTEXT.md §4.39). Admin only. `?path=` lists a folder;
 * `?secret=` reads one secret shaped for the datasource sheet - plain fields as values, the
 * credential as a reference - and leaves an audit line, since a person read a secret's
 * shape. What Vault said stays in the server log; the client learns only that it refused.
 */
export async function GET(request: Request) {
  const route = "GET /api/admin/vault/kv";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  if (!isVaultConfigured()) {
    return NextResponse.json({ error: "Vault is not configured on the server (VAULT_ADDR)" }, { status: 503 });
  }
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  try {
    if (secret === null) return NextResponse.json(await browseKv(url.searchParams.get("path") ?? ""));
    const shaped = await secretFields(secret);
    emitAuditEvent({
      type: "vault_secret",
      action: "read",
      target: shaped.path,
      user: gate.session.username,
      result: "success",
      details: `${Object.keys(shaped.fields).length + Object.keys(shaped.references).length} of ${shaped.keys.length} keys understood`,
    });
    return NextResponse.json(shaped);
  } catch (error) {
    if (error instanceof VaultError) {
      if (error.status === 400) return NextResponse.json({ error: error.message }, { status: 400 });
      logger.warn("Vault KV request refused", { route, status: error.status, message: error.message });
      return NextResponse.json({ error: "Vault refused or did not answer; see the server log" }, { status: 502 });
    }
    return createErrorResponse(error, { route });
  }
}
