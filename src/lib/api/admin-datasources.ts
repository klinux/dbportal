import { NextResponse } from "next/server";
import { getSession, type UserPayload } from "@/lib/auth";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { createErrorResponse } from "@/lib/api/errors";
import { SharedDatasourceError } from "@/lib/datasources/store";

/**
 * The three things every /api/admin/datasources handler does before and after its own work.
 * Admin only: the whole point of the feature is that nobody else creates a connection. In a
 * lib module because a Next.js route file may export nothing but its handlers.
 *
 * Errors this module raises carry their own status (400 validation, 404, 409 id taken, 503 no
 * server store), so they are answered here rather than through `createErrorResponse`, which
 * knows the database and seed error classes and would file these under 500.
 */
export function answerSharedDatasourceError(error: unknown, route: string) {
  if (error instanceof SharedDatasourceError) {
    return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
  }
  return createErrorResponse(error, { route });
}

/**
 * Typed like `GuardResult` in require-session.ts, and for the same reason: as an inferred union
 * of two object literals TypeScript normalises both members with optional undefined keys, and
 * `"response" in gate` then narrows to a response that is "possibly undefined".
 */
export type AdminGate = { response: NextResponse } | { session: UserPayload };

export async function requireAdmin(route: string, request: Request): Promise<AdminGate> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    if (session) auditRoleDenial({ route, user: session.username, request });
    return { response: NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 }) };
  }
  return { session };
}

/** A body that is not a JSON object is a client error, answered before anything is read. */
export async function readObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
