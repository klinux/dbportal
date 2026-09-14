import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { answerRunbookError } from "@/lib/api/runbooks";
import { guardRoute } from "@/lib/api/require-session";
import { bindRunbook, findRunbook, RunbookError } from "@/lib/runbooks/store";
import { resolveConnection } from "@/lib/seed/resolve-connection";

type Params = { params: Promise<{ id: string }> };

/**
 * The statement a runbook becomes for the values given (docs/CONTEXT.md §4.20): the
 * engine's placeholders and the values to bind, which the studio then runs through the
 * ordinary query route, naming the runbook for the audit line. A runbook on a datasource
 * this session may not open is refused the way the datasource itself is.
 */
export async function POST(request: Request, { params }: Params) {
  const route = "POST /api/runbooks/[id]/prepare";
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const runbook = await findRunbook(id);
    if (!runbook) throw new RunbookError(`Runbook "${id}" not found`, 404);
    const connection = await resolveConnection({ connectionId: `seed:${runbook.datasource}` }, guard.session);
    const body = (await readObjectBody(request)) ?? {};
    const values = body.values;
    const bound = bindRunbook(
      runbook,
      values !== null && typeof values === "object" && !Array.isArray(values)
        ? (values as Record<string, unknown>)
        : {},
      connection.type,
    );
    return NextResponse.json({ runbook: runbook.id, datasource: runbook.datasource, ...bound });
  } catch (error) {
    return answerRunbookError(error, route);
  }
}
