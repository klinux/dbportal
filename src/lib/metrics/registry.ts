import type { AuditEvent } from "@/lib/audit";

/**
 * The portal's own metrics (docs/CONTEXT.md §4.11), in the Prometheus text format. A
 * registry of counters, gauges and one histogram, written by hand rather than a library:
 * five series need no client, and the state must live on `globalThis` - Next.js compiles
 * each route into its own module graph, so a module-level Map would be one registry per
 * entry and the scrape would see only its own (the audit sink and the seed state share
 * the same rule). Labels are closed values from the audit schema (event type, action,
 * outcome) and datasource names; never a person, a statement, or an address, which would
 * be unbounded and, for the first, a leak.
 */
const KEY = Symbol.for("dbportal.metrics");

type Labels = Record<string, string>;

interface Registry {
  startedAt: number;
  counters: Map<string, Map<string, { labels: Labels; value: number }>>;
  histograms: Map<string, Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>>;
  /** Gauges other modules own, read at scrape time; see registerGauge. */
  gauges: Map<string, { help: string; read: () => number }>;
}

/** Execution latency buckets, in seconds: sub-second detail, then the long tail up to a minute. */
export const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function registry(): Registry {
  const holder = globalThis as unknown as { [KEY]?: Registry };
  if (!holder[KEY])
    holder[KEY] = { startedAt: Date.now(), counters: new Map(), histograms: new Map(), gauges: new Map() };
  // A registry created by an older module instance (a hot reload in development) may
  // predate a map; give it one rather than fail every scrape until a restart.
  holder[KEY].gauges ??= new Map();
  return holder[KEY];
}

/** Tests only. */
export function resetMetrics(): void {
  const holder = globalThis as unknown as { [KEY]?: Registry };
  delete holder[KEY];
}

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

/** A label value as the text format wants it: backslash, quote and newline escaped. */
function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelText(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.length === 0 ? "" : `{${keys.map((k) => `${k}="${escape(labels[k])}"`).join(",")}}`;
}

export function incrementCounter(name: string, labels: Labels, by = 1): void {
  const reg = registry();
  let series = reg.counters.get(name);
  if (!series) {
    series = new Map();
    reg.counters.set(name, series);
  }
  const k = key(labels);
  const entry = series.get(k);
  if (entry) entry.value += by;
  else series.set(k, { labels, value: by });
}

export function observeHistogram(name: string, labels: Labels, value: number): void {
  const reg = registry();
  let series = reg.histograms.get(name);
  if (!series) {
    series = new Map();
    reg.histograms.set(name, series);
  }
  const k = key(labels);
  let entry = series.get(k);
  if (!entry) {
    entry = { labels, buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
    series.set(k, entry);
  }
  DURATION_BUCKETS.forEach((bound, i) => {
    if (value <= bound) entry.buckets[i] += 1;
  });
  entry.sum += value;
  entry.count += 1;
}

/** Every audit event is one increment: the whole product's activity, by type and outcome, from one hook. */
export function observeAuditEvent(event: Pick<AuditEvent, "type" | "action" | "result">): void {
  incrementCounter("dbportal_audit_events_total", { event: event.type, action: event.action, outcome: event.result });
}

/** One execution's latency, by route and datasource, whatever the outcome. */
export function observeExecution(route: string, connectionName: string, durationMs: number): void {
  observeHistogram("dbportal_execution_duration_seconds", { route, datasource: connectionName }, durationMs / 1000);
}

/**
 * A gauge a module owns - the provider cache registers its size here at load - read when
 * the scrape happens. Registered on the shared registry so the value is the one the
 * module that holds the state sees, whichever Next.js entry served the scrape; a reader
 * that throws is skipped, never a failed scrape.
 */
export function registerGauge(name: string, help: string, read: () => number): void {
  registry().gauges.set(name, { help, read });
}

/** A gauge the scrape computes on the spot: pending approvals, cache sizes, uptime. */
export interface GaugeSample {
  name: string;
  help: string;
  value: number;
  labels?: Labels;
}

const HELP: Record<string, string> = {
  dbportal_audit_events_total: "Audit events emitted, by event type, action and outcome.",
  dbportal_execution_duration_seconds: "Latency of statements run through the portal, by route and datasource.",
  dbportal_audit_export_total: "Audit lines shipped to, rejected by, or dropped before a SIEM sink.",
  dbportal_jobs_total: "Jobs a worker finished, by kind and outcome (done, retry, failed).",
  dbportal_job_wait_seconds: "Time a job waited in the queue before a worker took it, by kind.",
  dbportal_job_run_seconds: "Time a worker spent on a job, by kind, whatever the outcome.",
};

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toString();
}

/** The whole registry plus the given gauges, in the Prometheus text exposition format (0.0.4). */
export function renderMetrics(gauges: GaugeSample[] = []): string {
  const reg = registry();
  const lines: string[] = [];
  for (const [name, series] of reg.counters) {
    lines.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} counter`);
    for (const entry of series.values()) lines.push(`${name}${labelText(entry.labels)} ${formatNumber(entry.value)}`);
  }
  for (const [name, series] of reg.histograms) {
    lines.push(`# HELP ${name} ${HELP[name] ?? name}`, `# TYPE ${name} histogram`);
    for (const entry of series.values()) {
      DURATION_BUCKETS.forEach((bound, i) => {
        lines.push(`${name}_bucket${labelText({ ...entry.labels, le: String(bound) })} ${entry.buckets[i]}`);
      });
      lines.push(`${name}_bucket${labelText({ ...entry.labels, le: "+Inf" })} ${entry.count}`);
      lines.push(`${name}_sum${labelText(entry.labels)} ${formatNumber(entry.sum)}`);
      lines.push(`${name}_count${labelText(entry.labels)} ${entry.count}`);
    }
  }
  const uptime: GaugeSample = {
    name: "dbportal_uptime_seconds",
    help: "Seconds since this process first recorded a metric.",
    value: Math.floor((Date.now() - reg.startedAt) / 1000),
  };
  const registered: GaugeSample[] = [];
  for (const [name, { help, read }] of reg.gauges) {
    try {
      registered.push({ name, help, value: read() });
    } catch {
      // The module that owns the gauge could not answer; the rest of the scrape still does.
    }
  }
  const seen = new Set<string>();
  for (const gauge of [...registered, ...gauges, uptime]) {
    if (!seen.has(gauge.name)) {
      seen.add(gauge.name);
      lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
    }
    lines.push(`${gauge.name}${labelText(gauge.labels ?? {})} ${formatNumber(gauge.value)}`);
  }
  return `${lines.join("\n")}\n`;
}
