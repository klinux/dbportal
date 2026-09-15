import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerJobError } from "@/lib/api/jobs";
import { DEFAULT_STATS_HOURS, jobStats } from "@/lib/jobs/stats";

/** The queue's statistics over a window (docs/CONTEXT.md §4.40): `?hours=` from 1 to 720, 24 by default. */
export async function GET(request: Request) {
  const route = "GET /api/admin/jobs/stats";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const hours = Number(new URL(request.url).searchParams.get("hours") ?? DEFAULT_STATS_HOURS);
    return NextResponse.json(await jobStats(Number.isFinite(hours) ? hours : DEFAULT_STATS_HOURS));
  } catch (error) {
    return answerJobError(error, route);
  }
}
