import { NextResponse } from "next/server";
import { answerEnvironmentError } from "@/lib/api/environments";
import { guardRoute } from "@/lib/api/require-session";
import { listEnvironments } from "@/lib/environments/store";

/** The environments as every listing files datasources under them (docs/CONTEXT.md §4.36); any session. */
export async function GET(request: Request) {
  const route = "GET /api/environments";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const environments = (await listEnvironments()).map(({ environment }) => environment);
    return NextResponse.json({ environments });
  } catch (error) {
    return answerEnvironmentError(error, route);
  }
}
