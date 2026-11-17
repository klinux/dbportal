import { logger } from "@/lib/logger";
import { listSeenPrincipals } from "@/lib/principals-seen";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Who uses the portal (docs/CONTEXT.md §4.60): every person seen signing in, with the dates,
 * role, groups and method of their last sign-in, and how many sign-ins the audit record holds
 * for them over the last {@link SIGN_IN_WINDOW_DAYS} days. Built from what already exists -
 * the seen-principals document (§4.49) and the persisted audit record (§4.2) - so there is no
 * new table and nothing a sign-in writes beyond what it did. Not "who is online": sessions are
 * signed cookies the server does not list.
 */
export const SIGN_IN_WINDOW_DAYS = 30;
/**
 * The most sign-in events one listing reads. Login events are small and a fleet signs in a few
 * hundred times a day, so this covers the window several times over; past it the counts are a
 * floor and the response says so rather than pretending to be exact.
 */
export const SIGN_IN_SCAN_MAX = 20_000;

export interface PortalUser {
  username: string;
  firstSeenAt: string;
  lastSeenAt: string;
  role?: "admin" | "user";
  groups?: string[];
  method?: "password" | "oidc";
  /** Sign-ins in the window, from the audit record; null when the record could not be read. */
  signIns: number | null;
}

export interface PortalUsers {
  /** False without a server store: nothing is remembered, so the page explains instead. */
  available: boolean;
  users: PortalUser[];
  windowDays: number;
  /** True when the window held more sign-ins than one listing reads (counts are a floor). */
  countsCapped: boolean;
}

/** Sign-ins per username over the window, or null when the audit record is out of reach. */
async function countSignIns(now: Date): Promise<{ counts: Map<string, number>; capped: boolean } | null> {
  try {
    const provider = await getStorageProvider();
    if (!provider) return null;
    const from = new Date(now.getTime() - SIGN_IN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const events = await provider.listAuditEvents({ type: "login_success", from, limit: SIGN_IN_SCAN_MAX });
    const counts = new Map<string, number>();
    for (const event of events) {
      if (event.user) counts.set(event.user, (counts.get(event.user) ?? 0) + 1);
    }
    return { counts, capped: events.length >= SIGN_IN_SCAN_MAX };
  } catch (error) {
    logger.warn("Sign-in counts could not be read from the audit record", {
      route: "portal-users",
      error: error instanceof Error ? error.name : "error",
    });
    return null;
  }
}

export async function listPortalUsers(now = new Date()): Promise<PortalUsers> {
  if (!isServerStorageEnabled()) {
    return { available: false, users: [], windowDays: SIGN_IN_WINDOW_DAYS, countsCapped: false };
  }
  const [principals, signIns] = await Promise.all([listSeenPrincipals(), countSignIns(now)]);
  const users = principals
    .filter((p) => p.id.startsWith("user:"))
    .map((p): PortalUser => {
      const username = p.id.slice("user:".length);
      const user: PortalUser = {
        username,
        firstSeenAt: p.firstSeenAt,
        lastSeenAt: p.lastSeenAt,
        signIns: signIns ? (signIns.counts.get(username) ?? 0) : null,
      };
      if (p.role) user.role = p.role;
      if (p.groups) user.groups = p.groups;
      if (p.method) user.method = p.method;
      return user;
    })
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { available: true, users, windowDays: SIGN_IN_WINDOW_DAYS, countsCapped: signIns?.capped ?? false };
}
