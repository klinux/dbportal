import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerEnvironmentError } from "@/lib/api/environments";
import { listSharedDatasources } from "@/lib/datasources/store";
import { deleteEnvironment } from "@/lib/environments/store";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/** Delete a stored environment (docs/CONTEXT.md §4.36): never production, never one a datasource uses. */
export async function DELETE(request: Request, { params }: Params) {
  const route = "DELETE /api/admin/environments/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const record = await deleteEnvironment(id, async (env) =>
      (await listSharedDatasources()).some((d) => d.environment === env),
    );
    emitAuditEvent({
      type: "environment",
      action: "deleted",
      target: record.id,
      user: gate.session.username,
      result: "success",
    });
    logger.info("Environment deleted", { route, environmentId: record.id, user: gate.session.username });
    return NextResponse.json({ deleted: record.id });
  } catch (error) {
    return answerEnvironmentError(error, route);
  }
}
