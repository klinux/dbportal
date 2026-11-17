import { SHARED_PRINCIPALS_OWNER } from "@/lib/datasources/owner";
import { logger } from "@/lib/logger";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { Role } from "@/lib/auth";
import type { SeenPrincipalRecord } from "@/lib/storage/types";

/**
 * The people and groups seen signing in (docs/CONTEXT.md §4.49): what the identity provider
 * sent as the username and the groups, remembered so the principal picker offers them before
 * anybody has typed them into a rule. Not a directory - only who has signed in - and never
 * more than the id and two dates - plus, on a person, the role, groups and method of their
 * last sign-in for the Users page (§4.60). One document under the reserved owner; a sign-in
 * writes it only when it brings a principal the document lacks, one it has not seen for an
 * hour (a person) or a day (a group), or a person whose role, groups or method changed, so a
 * login costs a read and rarely a write; and it never fails a sign-in - the store's trouble
 * is a warning here and nothing to the person logging in.
 */
const COLLECTION = "seen_principals" as const;
/** How long a remembered group is left alone before a sign-in refreshes its date. */
export const REFRESH_MS = 24 * 60 * 60 * 1000;
/**
 * The same for a person, tighter: the Users page (§4.60) shows their last sign-in, and a
 * day-old date there reads as "has not been here today". An hour keeps a login at a read
 * and, for somebody signing in all day, a write an hour.
 */
export const USER_REFRESH_MS = 60 * 60 * 1000;

/** What a sign-in says about the person, kept on their entry for the Users page (§4.60). */
export interface SignInDetail {
  role: Role;
  method: "password" | "oidc";
}
/** The document's ceiling; past it the longest unseen go first. */
export const MAX_SEEN = 5000;

export async function listSeenPrincipals(): Promise<SeenPrincipalRecord[]> {
  if (!isServerStorageEnabled()) return [];
  const provider = await getStorageProvider();
  if (!provider) return [];
  return (await provider.getCollection(SHARED_PRINCIPALS_OWNER, COLLECTION)) ?? [];
}

/** The ids a sign-in brings: the person, and each group the provider named. */
export function signInPrincipals(username: string, groups: readonly string[] = []): string[] {
  const ids = new Set<string>();
  const user = username.trim();
  if (user) ids.add(`user:${user}`);
  for (const group of groups) {
    const name = group.trim();
    if (name) ids.add(`group:${name}`);
  }
  return [...ids];
}

/** Whether the person's entry already says what this sign-in says. */
function sameDetail(known: SeenPrincipalRecord, detail: SignInDetail, groups: readonly string[]): boolean {
  return (
    known.role === detail.role &&
    known.method === detail.method &&
    JSON.stringify(known.groups ?? []) === JSON.stringify(groups)
  );
}

export async function rememberSignIn(
  username: string,
  groups: readonly string[] = [],
  now = new Date(),
  detail?: SignInDetail,
): Promise<void> {
  try {
    if (!isServerStorageEnabled()) return;
    const provider = await getStorageProvider();
    if (!provider) return;
    const ids = signInPrincipals(username, groups);
    if (ids.length === 0) return;
    const at = now.toISOString();
    const records = (await provider.getCollection(SHARED_PRINCIPALS_OWNER, COLLECTION)) ?? [];
    const byId = new Map(records.map((r) => [r.id, r]));
    const userId = `user:${username.trim()}`;
    const groupNames = ids.filter((id) => id.startsWith("group:")).map((id) => id.slice("group:".length));
    let changed = false;
    for (const id of ids) {
      const known = byId.get(id);
      const isUser = id === userId;
      const extra = isUser && detail ? { role: detail.role, method: detail.method, groups: groupNames } : {};
      if (!known) {
        byId.set(id, { id, firstSeenAt: at, lastSeenAt: at, ...extra });
        changed = true;
      } else if (
        now.getTime() - Date.parse(known.lastSeenAt) >= (isUser ? USER_REFRESH_MS : REFRESH_MS) ||
        (isUser && detail !== undefined && !sameDetail(known, detail, groupNames))
      ) {
        byId.set(id, { ...known, lastSeenAt: at, ...extra });
        changed = true;
      }
    }
    if (!changed) return;
    const kept = [...byId.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, MAX_SEEN);
    await provider.setCollection(SHARED_PRINCIPALS_OWNER, COLLECTION, kept);
  } catch (error) {
    logger.warn("Sign-in principals could not be remembered", {
      route: "principals-seen",
      error: error instanceof Error ? error.name : "error",
    });
  }
}
