import { NextResponse } from "next/server";
import { readObjectBody } from "@/lib/api/admin-datasources";
import { answerProvisionError, readAccountRequest } from "@/lib/api/provisioning";
import { guardRoute } from "@/lib/api/require-session";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { provisionAccount } from "@/lib/provisioning/run";

type Params = { params: Promise<{ id: string }> };

/**
 * Provision, or rotate, the portal's own account on this datasource (docs/CONTEXT.md
 * §4.54): the plan the sibling route showed is built again against the live inventory,
 * refused with its blockers if any remain, and otherwise run statement by statement; the
 * password is kept where the deployment keeps secrets and the datasource swapped to it.
 * The report carries every statement's outcome and never a password.
 */
// The context is read after the guard, so a request with no session is refused before
// anything about the route is touched (tests/security/route-auth.test.ts calls every
// provider-reaching POST with the request alone).
export async function POST(request: Request, context: Params): Promise<NextResponse> {
  const route = "POST /api/admin/datasources/[id]/account";
  const gate = await guardRoute({ route, bucket: "query", request });
  if ("response" in gate) return gate.response;
  if (gate.session.role !== "admin") {
    auditRoleDenial({ route, user: gate.session.username, request });
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }
  try {
    const { id } = await context.params;
    const body = readAccountRequest((await readObjectBody(request)) ?? {});
    const report = await provisionAccount({ datasourceId: id, ...body, actor: gate.session.username });
    return NextResponse.json(report, { status: report.completed ? 200 : 409 });
  } catch (error) {
    return answerProvisionError(error, route);
  }
}
