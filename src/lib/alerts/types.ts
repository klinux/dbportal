/**
 * The vocabulary of an alert (docs/CONTEXT.md §4.29), shared by the store on the server
 * and the editor in the browser; kept apart from the store so the client bundle never
 * pulls the storage backend behind it.
 */
export const ALERT_OPS = [">", ">=", "<", "<=", "==", "!=", "changed", "any_rows", "no_rows"] as const;
export type AlertOp = (typeof ALERT_OPS)[number];
export const ALERT_SQL_MAX_CHARS = 20_000;
export const ALERT_MIN_MINUTES = 1;
export const ALERT_MAX_MINUTES = 7 * 24 * 60;

/** The operators that compare the value against one the alert states. */
export const COMPARING_OPS: readonly AlertOp[] = [">", ">=", "<", "<=", "==", "!="];

export interface AlertDefinition {
  id: string;
  name: string;
  datasource: string;
  sql: string;
  /** The column the value is read from; the first column when absent. */
  column?: string;
  op: AlertOp;
  value?: number | string;
  everyMinutes: number;
  cooldownMinutes: number;
  channels: string[];
  enabled: boolean;
}

export interface AlertOwner {
  username: string;
  role: string;
  groups?: string[];
  namedRoles?: string[];
}

export type AlertStatus = "unknown" | "ok" | "firing" | "error";

export interface AlertState {
  status: AlertStatus;
  lastRunAt?: string;
  /** The value read on the last run, as text. */
  lastValue?: string;
  /** Why the last run failed: a closed word (the audit reason), never the engine's message. */
  lastError?: string;
  lastFiredAt?: string;
  lastNotifiedAt?: string;
}

export interface AlertRecord extends AlertDefinition {
  owner: AlertOwner;
  createdAt: string;
  updatedAt: string;
  state: AlertState;
}
