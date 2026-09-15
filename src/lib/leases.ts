import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";
import type { LeaseRecord } from "@/lib/storage/types";

/**
 * Leases in the store (docs/CONTEXT.md §4.41): what lets several instances of the studio
 * agree on who does a thing that must happen once. A lease is a name, a holder and an
 * instant; the store grants it to one holder at a time and lets that holder renew it, and
 * anyone take it once it expired. `holdLease` is how a loop elects a leader on every tick:
 * the instance that holds the lease works, the others wait, and an instance that dies
 * loses the lease within its TTL. `onceWithin` is the same table used as a cooldown shared
 * across instances: a fresh holder every time, so nobody - the same instance included -
 * passes twice inside the window. Without a server store there is one instance, and both
 * answer as that instance would.
 */
/** The alert scheduler's lease (§4.29, §4.41): one studio replica hands alerts over at a time. */
export const ALERT_SCHEDULER_LEASE = "alerts-scheduler";

const KEY = Symbol.for("dbportal.leases");
interface State {
  name: string;
  held: Map<string, boolean>;
  local: Map<string, number>;
}
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  g[KEY] ??= { name: `${hostname()}:${process.pid}`, held: new Map(), local: new Map() };
  return g[KEY];
}

/** Tests only. */
export function resetLeases(): void {
  delete (globalThis as typeof globalThis & { [KEY]?: State })[KEY];
}

/** This process, as the store names it in a lease: host and pid. */
export function instanceName(): string {
  return state().name;
}

/** Whether this process held `name` the last time it asked. */
export function holdsLease(name: string): boolean {
  return state().held.get(name) === true;
}

/**
 * Take or renew the lease for `ttlMs` from `now`. True when this instance holds it. A
 * change of hands is one log line each way, so a rollout shows who leads.
 */
export async function holdLease(name: string, ttlMs: number, now = new Date()): Promise<boolean> {
  const s = state();
  const before = s.held.get(name) === true;
  let held: boolean;
  if (!isServerStorageEnabled()) {
    held = true;
  } else {
    try {
      const store = await getStorageProvider();
      held = store
        ? await store.acquireLease(name, s.name, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString())
        : false;
    } catch (error) {
      // A store that does not answer grants nothing: better a tick skipped than two leaders.
      logger.warn("Lease could not be asked for", { route: "leases", lease: name, error: (error as Error).name });
      held = false;
    }
  }
  s.held.set(name, held);
  if (held !== before) {
    logger.info(held ? "Lease taken" : "Lease lost", { route: "leases", lease: name, holder: s.name });
  }
  return held;
}

/** True once per `windowMs` for `name`, across every instance that shares the store. */
export async function onceWithin(name: string, windowMs: number, now = Date.now()): Promise<boolean> {
  const s = state();
  if (!isServerStorageEnabled()) {
    const last = s.local.get(name);
    if (last !== undefined && now - last < windowMs) return false;
    s.local.set(name, now);
    return true;
  }
  try {
    const store = await getStorageProvider();
    if (!store) return false;
    return await store.acquireLease(
      name,
      randomUUID(),
      new Date(now).toISOString(),
      new Date(now + windowMs).toISOString(),
    );
  } catch (error) {
    logger.warn("Cooldown could not be asked for", { route: "leases", lease: name, error: (error as Error).name });
    return false;
  }
}

export async function listLeases(): Promise<LeaseRecord[]> {
  if (!isServerStorageEnabled()) return [];
  const store = await getStorageProvider();
  return store ? store.listLeases() : [];
}
