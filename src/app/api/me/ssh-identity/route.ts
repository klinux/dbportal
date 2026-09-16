import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { deleteSshIdentity, getSshIdentity, putSshIdentity, SshIdentityError, toSshIdentityView } from "@/lib/ssh-identity/store";

/**
 * A person's own SSH identity (docs/CONTEXT.md §4.9): read as a view, saved, removed.
 * Administrators only for now - the people who hold OS Login users on the bastions - and
 * always the caller's own: the owner is the session's username, never a parameter.
 */
function answer(error: unknown, route: string): NextResponse {
  if (error instanceof SshIdentityError) {
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  logger.error("SSH identity route failed", error, { route });
  return NextResponse.json({ error: "Internal server error", statusCode: 500 }, { status: 500 });
}

export async function GET(request: Request): Promise<NextResponse> {
  const route = "GET /api/me/ssh-identity";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const record = await getSshIdentity(gate.session.username);
    return NextResponse.json({ identity: record ? toSshIdentityView(record) : null });
  } catch (error) {
    return answer(error, route);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const route = "PUT /api/me/ssh-identity";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be a JSON object", statusCode: 400 }, { status: 400 });
    }
    const record = await putSshIdentity(gate.session.username, body);
    emitAuditEvent({
      type: "ssh_identity",
      action: "updated",
      target: gate.session.username,
      user: gate.session.username,
      result: "success",
      details: `ssh user ${record.username}`,
    });
    return NextResponse.json({ identity: toSshIdentityView(record) });
  } catch (error) {
    return answer(error, route);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const route = "DELETE /api/me/ssh-identity";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const removed = await deleteSshIdentity(gate.session.username);
    if (removed) {
      emitAuditEvent({
        type: "ssh_identity",
        action: "deleted",
        target: gate.session.username,
        user: gate.session.username,
        result: "success",
      });
    }
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    return answer(error, route);
  }
}
