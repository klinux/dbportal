import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getServerAuditBuffer, sanitizeAuditInput } from "@/lib/audit";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { getStorageProvider } from "@/lib/storage/factory";
import { matchesAuditQuery, readAuditQuery } from "@/lib/audit-query";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      if (session) auditRoleDenial({ route: "GET /api/admin/audit", user: session.username, request });
      return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
    }

    // The page's question (docs/CONTEXT.md §4.27): type, actor, datasource, result, period,
    // and which page of it.
    const read = readAuditQuery(new URL(request.url).searchParams);
    if ("error" in read) return NextResponse.json({ error: read.error }, { status: 400 });
    const { query } = read;
    const { limit, offset = 0, ...filter } = query;

    // The durable record when a server store is configured (docs/CONTEXT.md §4.2) - every
    // process, every restart - and the per-process ring buffer otherwise.
    const store = await getStorageProvider();
    if (store) {
      const [events, total] = await Promise.all([store.listAuditEvents(query), store.countAuditEvents(filter)]);
      return NextResponse.json({ events, total, limit, offset, source: "store" });
    }

    const matching = getServerAuditBuffer()
      .getAll()
      .filter((event) => matchesAuditQuery(event, filter))
      .reverse();
    const events = matching.slice(offset, offset + limit);
    return NextResponse.json({ events, total: matching.length, limit, offset, source: "buffer" });
  } catch (error) {
    return createErrorResponse(error, { route: "GET /api/admin/audit" });
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    if (session) auditRoleDenial({ route: "POST /api/admin/audit", user: session.username, request });
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }

  try {
    // Sanitizes (sanitizeAuditInput), then pushes to the display buffer directly — deliberately
    // NOT emitAuditEvent. This body is fully client-supplied and none of type/result/reason is
    // validated at runtime (request.json() is `any`; the closed unions only exist at compile
    // time), so this route must never gain the authority to write the stdout channel the design
    // treats as authoritative. Granting that would let an admin session, or a stolen one, forge a
    // dbportal.audit.v1 line indistinguishable from one the system generated. See task-4-brief.md:
    // this endpoint stays a display-only passthrough.
    const event = await request.json();
    const buffer = getServerAuditBuffer();
    const created = buffer.push(
      sanitizeAuditInput({
        ...event,
        user: session.username || "admin",
      }),
    );

    return NextResponse.json({ event: created });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/admin/audit" });
  }
}
