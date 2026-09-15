import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { answerSeedDataError } from "@/lib/api/seed-data";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { readCatalog, readSchemaName } from "@/lib/seed-data/catalog";
import { SeedDataError } from "@/lib/seed-data/errors";
import { enqueueSeed } from "@/lib/seed-data/job";
import { buildPlan, readCounts, readRatios } from "@/lib/seed-data/plan";
import { assertSeedable } from "@/lib/seed-data/run";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * Start a seed (docs/CONTEXT.md §4.23, §4.31): the catalog is read here to validate what was
 * asked - the counts bounded, the ratios on tables with a parent, the source another
 * PostgreSQL this session may open - and the seed is handed to the queue (§4.40), where a
 * worker runs it and writes each table's progress; this answers 202 with the run to poll.
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
    const mode = body.mode === "copy" ? "copy" : "generate";
    let sourceName: string | undefined;
    let sourceDatasourceId: string | undefined;
    if (mode === "copy") {
      sourceDatasourceId = typeof body.sourceDatasourceId === "string" ? body.sourceDatasourceId.trim() : "";
      if (!sourceDatasourceId) throw new SeedDataError("sourceDatasourceId is required to copy a sample", 400);
      if (sourceDatasourceId === datasourceId) {
        throw new SeedDataError("The sample must come from another datasource", 400);
      }
      const sourceConnection = await resolveConnection({ connectionId: `seed:${sourceDatasourceId}` }, gate.session);
      if (sourceConnection.type !== "postgres") {
        throw new SeedDataError("A sample is copied from a PostgreSQL datasource only", 403);
      }
      sourceName = sourceConnection.name;
    }
    const run = await enqueueSeed(
      { datasourceId, schema, counts, ratios, mode, sourceDatasourceId, truncate: body.truncate === true },
      plan,
      { target: connection.name, source: sourceName },
      gate.session,
    );
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return answerSeedDataError(error, route);
  }
}
