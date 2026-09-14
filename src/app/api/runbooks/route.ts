import { NextResponse } from "next/server";
import { principalsOf } from "@/lib/access";
import { answerRunbookError } from "@/lib/api/runbooks";
import { guardRoute } from "@/lib/api/require-session";
import { listRunbooks } from "@/lib/runbooks/store";
import { getManagedConnections } from "@/lib/seed";

/**
 * The runbooks this session may run (docs/CONTEXT.md §4.20): those on the datasources it
 * may open. Empty for a session that may open none, never a 403: the list is the answer.
 */
export async function GET(request: Request) {
  const route = "GET /api/runbooks";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const visible = new Set((await getManagedConnections(principalsOf(guard.session))).map((c) => c.seedId ?? c.id));
    const runbooks = (await listRunbooks()).map((e) => e.runbook).filter((r) => visible.has(r.datasource));
    return NextResponse.json({ runbooks });
  } catch (error) {
    return answerRunbookError(error, route);
  }
}
