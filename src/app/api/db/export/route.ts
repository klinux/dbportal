import { NextResponse } from "next/server";
import { canExport, isReadStatement } from "@/lib/access";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { statementTooLarge } from "@/lib/api/statement-size";
import { exportFileOf, ExportRequestError, readExportRequest } from "@/lib/export/request";
import { enqueueJob, JobError, waitForJob } from "@/lib/jobs/queue";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { serveExport } from "./serve";

/**
 * A result as a file (docs/CONTEXT.md §4.22), built by a worker (§4.40): the datasource's
 * export rule and the statement's kind are checked here, the export is handed to the queue,
 * and this waits a while for the file - most exports are seconds - and streams it; past the
 * wait it answers 202 with the job id, and `GET /api/db/export/[jobId]` serves the file
 * once it is there. Only a statement that reads: a file of an UPDATE's result is not a thing.
 */
export const EXPORT_WAIT_MS = 30_000;

export async function POST(req: Request) {
  const route = "POST /api/db/export";
  const guard = await guardRoute({ route, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body.sql === "string") {
      const tooLarge = statementTooLarge(body.sql);
      if (tooLarge) return tooLarge;
    }
    const connection = await resolveConnection(body, guard.session);
    // The rule first, here and again on the worker: nothing is queued that may not leave.
    const payload = readExportRequest(body, guard.session, connection.id, clientAddress(req));
    if (!canExport(connection, guard.session)) {
      auditRoleDenial({ route, user: guard.session.username, request: req, reason: "export_not_allowed" });
      return NextResponse.json(
        { error: `Exports are not allowed for you on "${connection.name}"`, statusCode: 403 },
        { status: 403 },
      );
    }
    if (!isReadStatement(payload.sql, connection.type)) {
      return NextResponse.json({ error: "Only a statement that reads can be exported" }, { status: 400 });
    }
    const job = await enqueueJob({
      kind: "export",
      payload: payload as unknown as Record<string, unknown>,
      requestedBy: guard.session.username,
      maxAttempts: 1,
    });
    const settled = await waitForJob(job.id, EXPORT_WAIT_MS);
    if (!settled || settled.status === "queued" || settled.status === "running") {
      return NextResponse.json({ jobId: job.id, status: settled?.status ?? "queued" }, { status: 202 });
    }
    return serveExport(settled, await exportFileOf(settled));
  } catch (error) {
    if (error instanceof ExportRequestError || error instanceof JobError) {
      return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
    }
    return createErrorResponse(error, { route });
  }
}
