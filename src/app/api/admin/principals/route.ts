import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/admin-datasources";
import { createErrorResponse } from "@/lib/api/errors";
import { listKnownPrincipals } from "@/lib/principals";

/** The principals already named anywhere (docs/CONTEXT.md §4.37), for the admin pickers. Admin only. */
export async function GET(request: Request) {
  const route = "GET /api/admin/principals";
  const gate = await requireAdmin(route, request);
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json({ principals: await listKnownPrincipals() });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
