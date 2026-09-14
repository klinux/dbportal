import { NextResponse } from "next/server";

/**
 * GET /api/health/live (docs/CONTEXT.md §4.13): the process answers. Nothing else is
 * asked - a store or a Vault that is down is a readiness matter, and restarting the pod
 * for it would only make the outage a crash loop. Public, like every probe.
 */
export async function GET() {
  return NextResponse.json({ status: "alive", service: "dbportal", timestamp: new Date().toISOString() });
}
