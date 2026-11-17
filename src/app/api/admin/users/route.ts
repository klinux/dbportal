import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { listPortalUsers } from "@/lib/portal-users";

/** The people seen signing in, with their last sign-in and recent count (docs/CONTEXT.md §4.60). Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/users";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await listPortalUsers());
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
