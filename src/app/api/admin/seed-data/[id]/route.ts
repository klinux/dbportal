import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { answerSeedDataError } from "@/lib/api/seed-data";
import { getSeedRun } from "@/lib/seed-data/run";

type Params = { params: Promise<{ id: string }> };

/** Where a seed run is (docs/CONTEXT.md §4.23): per table, how many rows are in and what stopped it. */
export async function GET(request: Request, { params }: Params) {
  const route = "GET /api/admin/seed-data/[id]";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const { id } = await params;
    const run = getSeedRun(id);
    if (!run) return NextResponse.json({ error: `Seed run "${id}" not found`, statusCode: 404 }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    return answerSeedDataError(error, route);
  }
}
