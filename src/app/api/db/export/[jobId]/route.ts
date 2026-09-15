import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { exportFileOf } from "@/lib/export/request";
import { getJob } from "@/lib/jobs/queue";
import { serveExport } from "../serve";

type Params = { params: Promise<{ jobId: string }> };

/** The file of an export that outran the route's wait (docs/CONTEXT.md §4.40): its requester's to download; 202 while a worker still builds it. */
export async function GET(request: Request, { params }: Params) {
  const route = "GET /api/db/export/[jobId]";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { jobId } = await params;
    const job = await getJob(jobId);
    if (
      !job ||
      job.kind !== "export" ||
      (job.requestedBy !== guard.session.username && guard.session.role !== "admin")
    ) {
      return NextResponse.json({ error: `Export "${jobId}" not found`, statusCode: 404 }, { status: 404 });
    }
    if (job.status === "queued" || job.status === "running") {
      return NextResponse.json({ jobId: job.id, status: job.status }, { status: 202 });
    }
    return serveExport(job, await exportFileOf(job));
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
