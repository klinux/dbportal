import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { readObjectBody, requireAdmin } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { getTrailAlerts, saveTrailAlerts, TrailAlertsError } from "@/lib/trail-alerts/store";

/** Alerts on the trail (docs/CONTEXT.md §4.32): which channels each rule fires to. Admin only. */
export async function GET(request: Request) {
  const gate = await requireAdmin("GET /api/admin/trail-alerts", request);
  if ("response" in gate) return gate.response;
  return NextResponse.json({ trailAlerts: await getTrailAlerts() });
}

export async function PUT(request: Request) {
  const route = "PUT /api/admin/trail-alerts";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    const body = await readObjectBody(request);
    if (!body) return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    const config = await saveTrailAlerts(body, gate.session.username);
    emitAuditEvent({
      type: "alert",
      action: "trail_rules_saved",
      target: route,
      user: gate.session.username,
      result: "success",
      details: Object.entries(config.rules)
        .map(([rule, channels]) => `${rule}=${channels.length}`)
        .join(" "),
    });
    return NextResponse.json({ trailAlerts: config });
  } catch (error) {
    if (error instanceof TrailAlertsError) {
      return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
    }
    return createErrorResponse(error, { route });
  }
}
