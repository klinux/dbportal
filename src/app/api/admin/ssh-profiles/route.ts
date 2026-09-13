import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerSshProfileError } from "@/lib/api/ssh-profiles";
import { createSshProfile, listSshProfileViews, toSshProfileView } from "@/lib/ssh-profiles/store";
import { logger } from "@/lib/logger";

/** SSH profiles (docs/CONTEXT.md §4.9): the bastions datasources are reached through, secrets never returned. */
export async function GET(request: Request) {
  const route = "GET /api/admin/ssh-profiles";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json({ profiles: await listSshProfileViews() });
  } catch (error) {
    return answerSshProfileError(error, route);
  }
}

export async function POST(request: Request) {
  const route = "POST /api/admin/ssh-profiles";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const record = await createSshProfile(body, gate.session.username);
    emitAuditEvent({
      type: "ssh_profile",
      action: "created",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("SSH profile created", { route, profileId: record.id, user: gate.session.username });
    return NextResponse.json({ profile: toSshProfileView(record, "store") }, { status: 201 });
  } catch (error) {
    return answerSshProfileError(error, route);
  }
}
