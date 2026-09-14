import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { answerSeedDataError } from "@/lib/api/seed-data";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { readCatalog, readSchemaName } from "@/lib/seed-data/catalog";
import { buildPlan, readCounts } from "@/lib/seed-data/plan";
import { assertSeedable, startSeedRun } from "@/lib/seed-data/run";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * Start a seed (docs/CONTEXT.md §4.23): the catalog is read again here rather than trusted
 * from the plan the browser sent back, the counts are bounded, and the job runs on after this
 * answers with its id. `truncate: true` empties the tables first; the audit line says so.
 */
export async function POST(request: Request) {
  const route = "POST /api/admin/seed-data/run";
  // A session first, then the role, the way every route that reaches a provider answers.
  const gate = await guardRoute({ route, bucket: "query", request });
  if ("response" in gate) return gate.response;
  if (gate.session.role !== "admin") {
    auditRoleDenial({ route, user: gate.session.username, request });
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }
  try {
    const body = (await readObjectBody(request)) ?? {};
    const datasourceId = typeof body.datasourceId === "string" ? body.datasourceId.trim() : "";
    if (!datasourceId) return NextResponse.json({ error: "datasourceId is required" }, { status: 400 });
    const schema = readSchemaName(body.schema);
    const connection = await resolveConnection({ connectionId: `seed:${datasourceId}` }, gate.session);
    await assertSeedable(connection);
    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(gate.session.username),
    });
    const tables = await readCatalog(provider, schema);
    const counts = readCounts(body.counts, buildPlan(tables));
    const run = startSeedRun({
      connection,
      runner: provider,
      schema,
      tables,
      counts,
      truncate: body.truncate === true,
      actor: gate.session.username,
    });
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return answerSeedDataError(error, route);
  }
}
