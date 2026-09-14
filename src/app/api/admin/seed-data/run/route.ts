import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { answerSeedDataError } from "@/lib/api/seed-data";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { readCatalog, readSchemaName } from "@/lib/seed-data/catalog";
import { buildPlan, readCounts, readRatios } from "@/lib/seed-data/plan";
import { SeedDataError } from "@/lib/seed-data/errors";
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
    const plan = buildPlan(tables);
    const counts = readCounts(body.counts, plan);
    const ratios = readRatios(body.ratios, plan);
    // Copy mode (docs/CONTEXT.md §4.31): the source is any PostgreSQL datasource this session may open, read-only.
    const mode = body.mode === "copy" ? "copy" : "generate";
    let source: { runner: typeof provider; name: string } | undefined;
    if (mode === "copy") {
      const sourceId = typeof body.sourceDatasourceId === "string" ? body.sourceDatasourceId.trim() : "";
      if (!sourceId) throw new SeedDataError("sourceDatasourceId is required to copy a sample", 400);
      if (sourceId === datasourceId) throw new SeedDataError("The sample must come from another datasource", 400);
      const sourceConnection = await resolveConnection({ connectionId: `seed:${sourceId}` }, gate.session);
      if (sourceConnection.type !== "postgres")
        throw new SeedDataError("A sample is copied from a PostgreSQL datasource only", 403);
      source = {
        runner: await getOrCreateProvider(sourceConnection, {
          applicationName: applicationNameFor(gate.session.username),
          readOnly: true,
        }),
        name: sourceConnection.name,
      };
    }
    const run = startSeedRun({
      connection,
      runner: provider,
      schema,
      tables,
      counts,
      ratios,
      mode,
      source,
      truncate: body.truncate === true,
      actor: gate.session.username,
    });
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return answerSeedDataError(error, route);
  }
}
