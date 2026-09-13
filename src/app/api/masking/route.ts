import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getServerMaskingConfig } from "@/lib/masking/store";

/**
 * The masking configuration in force (docs/CONTEXT.md §4.7), for any signed-in session: the
 * grid marks the columns the server masked and offers a reveal only to the roles the
 * configuration names, so it needs the rules and the role settings - none of which is a
 * secret. A bare getSession(), like connections/managed: a render-time read is not metered.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  return NextResponse.json({ config: await getServerMaskingConfig() });
}
