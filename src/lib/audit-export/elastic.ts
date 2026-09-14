import { incrementCounter } from "@/lib/metrics/registry";
import { logger } from "@/lib/logger";

/**
 * The audit line shipped to Elasticsearch (docs/CONTEXT.md §4.12). The stdout line stays
 * the authoritative record; this is the copy a SIEM indexes. Events are batched into the
 * Bulk API as NDJSON (`create` with the event's own id, so a retry cannot duplicate), sent
 * when the batch fills or a short timer fires, retried a few times with backoff, and then
 * DROPPED with one warning and a counter - never a blocked request, never an unbounded
 * queue: an index that is down must not take the portal down with it.
 *
 * Off unless AUDIT_ELASTIC_URL is set. State lives on globalThis for the reason every
 * server-side singleton here does: one queue for the process, not one per Next.js entry.
 */
const KEY = Symbol.for("dbportal.audit-export");

export const DEFAULT_INDEX = "dbportal-audit";
export const DEFAULT_BATCH = 100;
export const DEFAULT_FLUSH_MS = 2000;
export const MAX_QUEUE = 10_000;
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;

export interface ElasticConfig {
  url: string;
  index: string;
  apiKey?: string;
  batch: number;
  flushMs: number;
}

interface State {
  queue: Record<string, unknown>[];
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

function state(): State {
  const holder = globalThis as unknown as { [KEY]?: State };
  if (!holder[KEY]) holder[KEY] = { queue: [], timer: null, inFlight: null };
  return holder[KEY];
}

/** Tests only: forget what is queued and any timer. */
export function resetAuditExport(): void {
  const holder = globalThis as unknown as { [KEY]?: State };
  if (holder[KEY]?.timer) clearTimeout(holder[KEY].timer);
  delete holder[KEY];
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The exporter's configuration from the environment, or null when it is off. */
export function elasticConfig(): ElasticConfig | null {
  const url = (process.env.AUDIT_ELASTIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return null;
  return {
    url,
    index: (process.env.AUDIT_ELASTIC_INDEX ?? "").trim() || DEFAULT_INDEX,
    ...(process.env.AUDIT_ELASTIC_API_KEY ? { apiKey: process.env.AUDIT_ELASTIC_API_KEY } : {}),
    batch: positiveInt(process.env.AUDIT_ELASTIC_BATCH, DEFAULT_BATCH),
    flushMs: positiveInt(process.env.AUDIT_ELASTIC_FLUSH_MS, DEFAULT_FLUSH_MS),
  };
}

function count(outcome: "shipped" | "failed" | "dropped", by: number): void {
  if (by > 0) incrementCounter("dbportal_audit_export_total", { sink: "elastic", outcome }, by);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Bulk request; true when every item was accepted. Throws on a transport or HTTP failure. */
async function bulk(config: ElasticConfig, lines: Record<string, unknown>[]): Promise<number> {
  const body = `${lines.map((line) => `${JSON.stringify({ create: { _index: config.index, _id: line.id } })}\n${JSON.stringify(line)}`).join("\n")}\n`;
  const res = await fetch(`${config.url}/_bulk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      ...(config.apiKey ? { Authorization: `ApiKey ${config.apiKey}` } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reply = (await res.json()) as { errors?: boolean; items?: { create?: { status?: number } }[] };
  if (!reply.errors) return 0;
  // 409 is the id already indexed - a retry of a batch that half-landed - which is success here.
  return (reply.items ?? []).filter((item) => {
    const status = item.create?.status ?? 0;
    return status >= 300 && status !== 409;
  }).length;
}

async function send(config: ElasticConfig, lines: Record<string, unknown>[]): Promise<void> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const rejected = await bulk(config, lines);
      count("shipped", lines.length - rejected);
      if (rejected > 0) {
        count("failed", rejected);
        logger.warn("Elasticsearch rejected audit events", { route: "audit-export", rejected, batch: lines.length });
      }
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        count("failed", lines.length);
        logger.warn("Audit events not exported to Elasticsearch", {
          route: "audit-export",
          batch: lines.length,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

/** Send what is queued now; awaited by tests and by a flush at shutdown, never by a request. */
export async function flushAuditExport(): Promise<void> {
  const s = state();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s.inFlight) await s.inFlight;
  const config = elasticConfig();
  if (!config || s.queue.length === 0) return;
  const lines = s.queue.splice(0, s.queue.length);
  s.inFlight = send(config, lines).finally(() => {
    s.inFlight = null;
  });
  await s.inFlight;
}

/** Queue one audit line. Returns at once; shipping happens on the batch or the timer. */
export function enqueueAuditExport(line: Record<string, unknown>): void {
  const config = elasticConfig();
  if (!config) return;
  const s = state();
  if (s.queue.length >= MAX_QUEUE) {
    s.queue.shift();
    count("dropped", 1);
  }
  s.queue.push(line);
  if (s.queue.length >= config.batch) {
    void flushAuditExport();
    return;
  }
  if (!s.timer) {
    s.timer = setTimeout(() => {
      s.timer = null;
      void flushAuditExport();
    }, config.flushMs);
    // A pending flush must not keep a process alive that is otherwise done.
    (s.timer as { unref?: () => void }).unref?.();
  }
}
