import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { ALERT_SCHEDULER_LEASE, holdsLease } from "@/lib/leases";
import { renderMetrics, type GaugeSample } from "@/lib/metrics/registry";
import { getStorageProvider } from "@/lib/storage/factory";

/**
 * GET /api/metrics (docs/CONTEXT.md §4.11): the portal's own metrics for Prometheus.
 * Behind `METRICS_TOKEN`, presented as a Bearer - a scrape is a machine, not a person, and
 * the series name datasources, so the endpoint is not public. Unset, it does not exist:
 * a 404 rather than an unauthenticated exposition nobody chose.
 */
const PENDING_SCAN = 1000;

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The gauges only the scrape can compute: what is waiting, and what is open. */
async function gauges(): Promise<GaugeSample[]> {
  const out: GaugeSample[] = [];
  out.push({
    name: "dbportal_build_info",
    help: "The running version, as a label.",
    value: 1,
    labels: { version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown" },
  });
  try {
    const store = await getStorageProvider();
    if (store) {
      const pending = await store.listApprovals({ status: "pending", limit: PENDING_SCAN });
      const oldest = pending.reduce((min, r) => Math.min(min, Date.parse(r.requestedAt)), Number.POSITIVE_INFINITY);
      out.push({
        name: "dbportal_approvals_pending",
        help: "Approval requests waiting for a reviewer.",
        value: pending.length,
      });
      out.push({
        name: "dbportal_approval_oldest_pending_seconds",
        help: "Age of the oldest approval request still waiting; 0 when none waits.",
        value: pending.length === 0 ? 0 : Math.max(0, Math.floor((Date.now() - oldest) / 1000)),
      });
      // The job queue (docs/CONTEXT.md §4.40): what an autoscaler of workers reads.
      out.push({
        name: "dbportal_jobs_queued",
        help: "Jobs waiting for a worker.",
        value: await store.countJobs("queued"),
      });
      out.push({
        name: "dbportal_jobs_running",
        help: "Jobs a worker holds a lease on.",
        value: await store.countJobs("running"),
      });
    }
  } catch (error) {
    // A store that is down is itself worth a series, not a failed scrape.
    logger.warn("Metrics could not read the approval queue", {
      route: "GET /api/metrics",
      error: (error as Error).name,
    });
    out.push({
      name: "dbportal_store_scrape_failed",
      help: "1 when the server store did not answer the scrape.",
      value: 1,
    });
  }
  return out;
}

/** Which instance leads the alert scheduler (§4.41): 1 on the leader, 0 elsewhere; what a rollout is watched by. */
function leadership(): GaugeSample[] {
  return [
    {
      name: "dbportal_alert_scheduler_leader",
      help: "1 when this instance holds the alert scheduler's lease.",
      value: holdsLease(ALERT_SCHEDULER_LEASE) ? 1 : 0,
    },
  ];
}

export async function GET(request: Request) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !tokenMatches(presented, expected)) {
    return NextResponse.json({ error: "A valid metrics token is required" }, { status: 401 });
  }
  return new NextResponse(renderMetrics([...leadership(), ...(await gauges())]), {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
  });
}
