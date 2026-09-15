import { deploymentRole } from "@/lib/config/role";
import { logger } from "@/lib/logger";
import { enqueueJob } from "@/lib/jobs/queue";
import { dueAlerts, updateAlertState } from "./store";

/**
 * The alert scheduler (docs/CONTEXT.md §4.29): one interval per process, started at boot,
 * that hands every alert whose time has come to the job queue (§4.40). It lives on globalThis
 * because Next.js gives each entry its own module instance and a server must hold one
 * scheduler, not one per route. Off with ALERTS_ENABLED=false, and off by default on any
 * role but the studio: the agent (§4.30) holds no alert of anyone's, and a worker (§4.40)
 * beside a studio would run every alert twice.
 */
export const DEFAULT_TICK_MS = 30_000;
const KEY = Symbol.for("dbportal.alert-scheduler");

interface Holder {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

function holder(): Holder {
  const g = globalThis as typeof globalThis & { [KEY]?: Holder };
  g[KEY] ??= { timer: null, running: false };
  return g[KEY];
}

export function alertsEnabled(): boolean {
  const flag = process.env.ALERTS_ENABLED?.trim().toLowerCase();
  if (flag !== undefined && flag !== "") return flag === "true" || flag === "1";
  // Only the studio schedules: the agent holds no alert of anyone's, and a worker (§4.40)
  // beside a studio would run every alert twice.
  return deploymentRole() === "studio";
}

export function tickMs(): number {
  const n = Number(process.env.ALERTS_TICK_MS);
  return Number.isFinite(n) && n >= 1_000 ? n : DEFAULT_TICK_MS;
}

/**
 * One pass: every due alert handed to the queue (§4.40) - a worker, or this process's own
 * loop, runs it - and marked as scheduled so the next pass does not hand it over again. A
 * pass still running when the next is due is not doubled.
 */
export async function tickOnce(now = new Date()): Promise<number> {
  const h = holder();
  if (h.running) return 0;
  h.running = true;
  let ran = 0;
  try {
    for (const alert of await dueAlerts(now.getTime())) {
      await enqueueJob({ kind: "alert", payload: { alertId: alert.id }, requestedBy: "scheduler", maxAttempts: 1 });
      await updateAlertState(alert.id, { ...alert.state, lastScheduledAt: now.toISOString() });
      ran++;
    }
  } catch (error) {
    logger.error("Alert scheduler pass failed", error, { route: "alerts/scheduler" });
  } finally {
    h.running = false;
  }
  return ran;
}

export function startAlertScheduler(): boolean {
  if (!alertsEnabled()) return false;
  const h = holder();
  if (h.timer) return true;
  h.timer = setInterval(() => void tickOnce(), tickMs());
  h.timer.unref?.();
  logger.info("Alert scheduler started", { route: "alerts/scheduler", tickMs: tickMs() });
  return true;
}

export function stopAlertScheduler(): void {
  const h = holder();
  if (h.timer) clearInterval(h.timer);
  h.timer = null;
  h.running = false;
}
