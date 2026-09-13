import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerSshProfileError } from "@/lib/api/ssh-profiles";
import { deleteSshProfile, toSshProfileView, updateSshProfile } from "@/lib/ssh-profiles/store";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const route = "PUT /api/admin/ssh-profiles/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await updateSshProfile(id, body, gate.session.username);
    emitAuditEvent({
      type: "ssh_profile",
      action: "updated",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("SSH profile updated", { route, profileId: record.id, user: gate.session.username });
    return NextResponse.json({ profile: toSshProfileView(record, "store") });
  } catch (error) {
    return answerSshProfileError(error, route);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/ssh-profiles/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await deleteSshProfile(id);
    emitAuditEvent({
      type: "ssh_profile",
      action: "deleted",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("SSH profile deleted", { route, profileId: record.id, user: gate.session.username });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerSshProfileError(error, route);
  }
}
