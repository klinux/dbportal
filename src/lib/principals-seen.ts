import { SHARED_PRINCIPALS_OWNER } from "@/lib/datasources/owner";
import { logger } from "@/lib/logger";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { SeenPrincipalRecord } from "@/lib/storage/types";

/**
 * The people and groups seen signing in (docs/CONTEXT.md §4.49): what the identity provider
 * sent as the username and the groups, remembered so the principal picker offers them before
 * anybody has typed them into a rule. Not a directory - only who has signed in - and never
 * more than the id and two dates. One document under the reserved owner; a sign-in writes it
 * only when it brings a principal the document lacks or has not seen for a day, so a login
 * costs a read and rarely a write; and it never fails a sign-in - the store's trouble is a
 * warning here and nothing to the person logging in.
 */
const COLLECTION = "seen_principals" as const;
/** How long a remembered principal is left alone before a sign-in refreshes its date. */
export const REFRESH_MS = 24 * 60 * 60 * 1000;
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

export async function rememberSignIn(username: string, groups: readonly string[] = [], now = new Date()): Promise<void> {
  try {
    if (!isServerStorageEnabled()) return;
    const provider = await getStorageProvider();
    if (!provider) return;
    const ids = signInPrincipals(username, groups);
    if (ids.length === 0) return;
    const at = now.toISOString();
    const records = (await provider.getCollection(SHARED_PRINCIPALS_OWNER, COLLECTION)) ?? [];
    const byId = new Map(records.map((r) => [r.id, r]));
    let changed = false;
    for (const id of ids) {
      const known = byId.get(id);
      if (!known) {
        byId.set(id, { id, firstSeenAt: at, lastSeenAt: at });
        changed = true;
      } else if (now.getTime() - Date.parse(known.lastSeenAt) >= REFRESH_MS) {
        byId.set(id, { ...known, lastSeenAt: at });
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
