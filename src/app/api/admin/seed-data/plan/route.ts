import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { answerSeedDataError } from "@/lib/api/seed-data";
import { getOrCreateProvider } from "@/lib/db";
import { applicationNameFor } from "@/lib/db/application-name";
import { readCatalog, readSchemaName } from "@/lib/seed-data/catalog";
import { seedEngineOf } from "@/lib/seed-data/engine";
import { buildPlan } from "@/lib/seed-data/plan";
import { assertSeedable } from "@/lib/seed-data/run";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * The plan of a seed (docs/CONTEXT.md §4.23): the schema read, the tables in the order they
 * would be filled with what each depends on, and a row count per table to edit. Admin only,
 * never production, PostgreSQL or MySQL; reads the catalog and writes nothing.
 */
export async function POST(request: Request) {
  const route = "POST /api/admin/seed-data/plan";
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
    const connection = await resolveConnection({ connectionId: `seed:${datasourceId}` }, gate.session);
    await assertSeedable(connection);
    // The engine decides what a schema is: PostgreSQL's `public` by default, MySQL's the database itself.
    const engine = seedEngineOf(connection.type) ?? "postgres";
    const schema = readSchemaName(body.schema, engine, connection.database);
    const provider = await getOrCreateProvider(connection, {
      applicationName: applicationNameFor(gate.session.username),
    });
    const tables = await readCatalog(provider, schema, engine);
    return NextResponse.json({ schema, tables: buildPlan(tables) });
  } catch (error) {
    return answerSeedDataError(error, route);
  }
}
