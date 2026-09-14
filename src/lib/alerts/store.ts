import { z } from "zod";
import type { AccessSession } from "@/lib/access";
import { SHARED_ALERTS_OWNER } from "@/lib/datasources/owner";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Alerts (docs/CONTEXT.md §4.29, asked 2026-09-14), in the shape of Redash's: a person
 * writes a read on a datasource they may open, how often it runs, and a condition on the
 * value it returns; when the condition holds, the alert fires to channels an administrator
 * declared, and again after a cooldown while it keeps holding; when it stops holding, it
 * resolves. Every run is a `query_execution` under the owner, read-only, bounded by the
 * datasource's limits.
 *
 * The owner is a snapshot: the run has no session, so the alert keeps the principals its
 * owner had when it was saved (role, groups, named roles) and opens the datasource with
 * those. Someone who loses access later sees the alert stop with "access"; editing it
 * takes a fresh snapshot. An administrator sees every alert; everyone else their own.
 */
import {
  ALERT_MAX_MINUTES,
  ALERT_MIN_MINUTES,
  ALERT_OPS,
  ALERT_SQL_MAX_CHARS,
  COMPARING_OPS,
  type AlertDefinition,
  type AlertOwner,
  type AlertRecord,
  type AlertState,
} from "./types";

export * from "./types";

export const AlertSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(64),
    datasource: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    sql: z.string().min(1).max(ALERT_SQL_MAX_CHARS),
    /** The column the value is read from; the first column when absent. */
    column: z.string().min(1).max(64).optional(),
    op: z.enum(ALERT_OPS),
    value: z.union([z.number(), z.string().max(200)]).optional(),
    everyMinutes: z.number().int().min(ALERT_MIN_MINUTES).max(ALERT_MAX_MINUTES),
    cooldownMinutes: z.number().int().min(0).max(ALERT_MAX_MINUTES),
    channels: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(10),
    enabled: z.boolean(),
  })
  .refine((a) => !COMPARING_OPS.includes(a.op) || a.value !== undefined, {
    message: "A comparison needs a value",
    path: ["value"],
  });

export type Alert = AlertDefinition;

export class AlertError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AlertError";
  }
}

const COLLECTION = "alerts" as const;
const STORE_UNAVAILABLE = "Alerts need server storage: set STORAGE_PROVIDER to sqlite or postgres";

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new AlertError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readAll(): Promise<AlertRecord[]> {
  if (!isServerStorageEnabled()) return [];
  const provider = await requireProvider();
  return (await provider.getCollection(SHARED_ALERTS_OWNER, COLLECTION)) ?? [];
}

async function writeAll(records: AlertRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_ALERTS_OWNER, COLLECTION, records);
}

export function ownerOf(session: AccessSession & { username: string }): AlertOwner {
  return {
    username: session.username,
    role: session.role,
    ...(session.groups?.length ? { groups: [...session.groups] } : {}),
    ...(session.namedRoles?.length ? { namedRoles: [...session.namedRoles] } : {}),
  };
}

/** May this session read, edit or delete the alert: its owner, or an administrator. */
export function mayManage(record: AlertRecord, session: { role: string; username: string }): boolean {
  return session.role === "admin" || record.owner.username === session.username;
}

/** Every alert an administrator, else the session's own. */
export async function listAlerts(session: { role: string; username: string }): Promise<AlertRecord[]> {
  return (await readAll()).filter((a) => mayManage(a, session));
}

export async function findAlert(id: string): Promise<AlertRecord | null> {
  return (await readAll()).find((a) => a.id === id) ?? null;
}

export function validateAlert(input: unknown): Alert {
  const result = AlertSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "alert"}: ${i.message}`).join("; ");
    throw new AlertError(`Invalid alert: ${issues}`, 400);
  }
  return result.data;
}

/**
 * Create or replace. The caller has already proven the owner may open the datasource and
 * the statement reads. A replaced alert keeps its state, so a firing one does not fire
 * again for being edited; it takes the editor as its new owner.
 */
export async function saveAlert(data: Alert, session: AccessSession & { username: string }): Promise<AlertRecord> {
  const records = await readAll();
  const existing = records.find((a) => a.id === data.id);
  if (existing && !mayManage(existing, session)) throw new AlertError(`Alert "${data.id}" is someone else's`, 403);
  const now = new Date().toISOString();
  const record: AlertRecord = {
    ...data,
    owner: ownerOf(session),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    state: existing?.state ?? { status: "unknown" },
  };
  await writeAll([...records.filter((a) => a.id !== data.id), record]);
  return record;
}

export async function deleteAlert(id: string, session: { role: string; username: string }): Promise<AlertRecord> {
  const records = await readAll();
  const existing = records.find((a) => a.id === id);
  if (!existing) throw new AlertError(`Alert "${id}" not found`, 404);
  if (!mayManage(existing, session)) throw new AlertError(`Alert "${id}" is someone else's`, 403);
  await writeAll(records.filter((a) => a.id !== id));
  return existing;
}

/** The runner's write: the state alone, never the definition. */
export async function updateAlertState(id: string, state: AlertState): Promise<AlertRecord | null> {
  const records = await readAll();
  const existing = records.find((a) => a.id === id);
  if (!existing) return null;
  const record = { ...existing, state };
  await writeAll(records.map((a) => (a.id === id ? record : a)));
  return record;
}

/** Whether a channel is still named by any alert (a channel in use cannot be deleted). */
export async function channelInUse(channelId: string): Promise<boolean> {
  return (await readAll()).some((a) => a.channels.includes(channelId));
}

/** The enabled alerts whose interval has elapsed since their last run, oldest run first. */
export async function dueAlerts(now: number): Promise<AlertRecord[]> {
  return (await readAll())
    .filter((a) => a.enabled)
    .filter((a) => !a.state.lastRunAt || Date.parse(a.state.lastRunAt) + a.everyMinutes * 60_000 <= now)
    .sort((a, b) => Date.parse(a.state.lastRunAt ?? "1970-01-01") - Date.parse(b.state.lastRunAt ?? "1970-01-01"));
}
