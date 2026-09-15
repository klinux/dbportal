import { NextResponse } from "next/server";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { answerJobError } from "@/lib/api/jobs";
import { enqueueJob } from "@/lib/jobs/queue";

/** A ping on the queue (docs/CONTEXT.md §4.40): proves a worker is there; read it back on GET /api/admin/jobs. */
export async function POST(request: Request) {
  const route = "POST /api/admin/jobs/ping";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = (await readObjectBody(request)) ?? {};
    const echo = typeof body.echo === "string" ? body.echo.slice(0, 64) : undefined;
    const job = await enqueueJob({ kind: "ping", payload: echo ? { echo } : {}, requestedBy: gate.session.username });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return answerJobError(error, route);
  }
}
