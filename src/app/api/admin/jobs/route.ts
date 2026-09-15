import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerJobError } from "@/lib/api/jobs";
import { countJobs, listJobs } from "@/lib/jobs/queue";
import type { JobStatus } from "@/lib/storage/types";

const STATUSES: JobStatus[] = ["queued", "running", "done", "failed", "lost"];

/** The queue as an administrator reads it (docs/CONTEXT.md §4.40): counts per status and the latest jobs. */
export async function GET(request: Request) {
  const route = "GET /api/admin/jobs";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const kind = url.searchParams.get("kind") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const counts: Record<string, number> = {};
    for (const s of STATUSES) counts[s] = await countJobs(s);
    const jobs = await listJobs({
      ...(status && STATUSES.includes(status as JobStatus) ? { status: status as JobStatus } : {}),
      ...(kind ? { kind } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return NextResponse.json({ counts, jobs });
  } catch (error) {
    return answerJobError(error, route);
  }
}
