import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { answerProvisionError, readAccountRequest } from "@/lib/api/provisioning";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { inspectAccount } from "@/lib/provisioning/run";

type Params = { params: Promise<{ id: string }> };

/**
 * The plan for the portal's own account on this datasource (docs/CONTEXT.md §4.54),
 * without running anything: the bootstrap connection is opened, the inventory read, and
 * the statements answered with every password masked, beside the blockers that would
 * stop the run. The bootstrap credential in the body, when there is one, is used for
 * this call and dropped.
 */
// The context is read after the guard, so a request with no session is refused before
// anything about the route is touched (tests/security/route-auth.test.ts calls every
// provider-reaching POST with the request alone).
export async function POST(request: Request, context: Params): Promise<NextResponse> {
  const route = "POST /api/admin/datasources/[id]/account/plan";
  const gate = await guardRoute({ route, bucket: "query", request });
  if ("response" in gate) return gate.response;
  if (gate.session.role !== "admin") {
    auditRoleDenial({ route, user: gate.session.username, request });
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }
  try {
    const { id } = await context.params;
    const body = readAccountRequest((await readObjectBody(request)) ?? {});
    const report = await inspectAccount({ datasourceId: id, ...body, actor: gate.session.username });
    return NextResponse.json(report);
  } catch (error) {
    return answerProvisionError(error, route);
  }
}
