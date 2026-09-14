import { describe, test, expect, beforeEach } from "bun:test";
import {
  DURATION_BUCKETS,
  incrementCounter,
  observeAuditEvent,
  observeExecution,
  observeHistogram,
  registerGauge,
  renderMetrics,
  resetMetrics,
} from "@/lib/metrics/registry";

/**
 * The metrics registry (docs/CONTEXT.md §4.11): counters and a histogram that survive
 * module boundaries (they live on globalThis), rendered in the Prometheus text format with
 * labels escaped and sorted, so a scrape parses whatever the labels held.
 */
describe("metrics registry", () => {
  beforeEach(() => {
    resetMetrics();
  });

  test("a counter accumulates per label set and renders with HELP and TYPE", () => {
    incrementCounter("dbportal_audit_events_total", { event: "login_success", action: "login", outcome: "success" });
    incrementCounter("dbportal_audit_events_total", { event: "login_success", action: "login", outcome: "success" });
    incrementCounter("dbportal_audit_events_total", { outcome: "failure", event: "login_failure", action: "login" }, 3);
    const text = renderMetrics();
    expect(text).toContain(
      "# HELP dbportal_audit_events_total Audit events emitted, by event type, action and outcome.",
    );
    expect(text).toContain("# TYPE dbportal_audit_events_total counter");
    expect(text).toContain('dbportal_audit_events_total{action="login",event="login_success",outcome="success"} 2');
    expect(text).toContain('dbportal_audit_events_total{action="login",event="login_failure",outcome="failure"} 3');
  });

  test("the histogram counts cumulative buckets, +Inf, sum and count per label set", () => {
    observeHistogram("dbportal_execution_duration_seconds", { route: "r", datasource: "Orders" }, 0.3);
    observeHistogram("dbportal_execution_duration_seconds", { route: "r", datasource: "Orders" }, 120);
    const text = renderMetrics();
    expect(text).toContain("# TYPE dbportal_execution_duration_seconds histogram");
    expect(text).toContain('dbportal_execution_duration_seconds_bucket{datasource="Orders",le="0.25",route="r"} 0');
    expect(text).toContain('dbportal_execution_duration_seconds_bucket{datasource="Orders",le="0.5",route="r"} 1');
    expect(text).toContain('dbportal_execution_duration_seconds_bucket{datasource="Orders",le="60",route="r"} 1');
    expect(text).toContain('dbportal_execution_duration_seconds_bucket{datasource="Orders",le="+Inf",route="r"} 2');
    expect(text).toContain('dbportal_execution_duration_seconds_sum{datasource="Orders",route="r"} 120.3');
    expect(text).toContain('dbportal_execution_duration_seconds_count{datasource="Orders",route="r"} 2');
    expect(DURATION_BUCKETS[DURATION_BUCKETS.length - 1]).toBe(60);
  });

  test("the two hooks map an audit event and an execution onto the right series, in seconds", () => {
    observeAuditEvent({ type: "query_execution", action: "query", result: "success" });
    observeExecution("POST /api/db/query", "Orders", 250);
    const text = renderMetrics();
    expect(text).toContain('dbportal_audit_events_total{action="query",event="query_execution",outcome="success"} 1');
    expect(text).toContain(
      'dbportal_execution_duration_seconds_sum{datasource="Orders",route="POST /api/db/query"} 0.25',
    );
  });

  test("label values are escaped, gauges are appended once with their HELP, and uptime is always last", () => {
    incrementCounter("x_total", { name: 'quote " back \\ line\nbreak' });
    const text = renderMetrics([
      { name: "g", help: "a gauge", value: 1.5, labels: { a: "1" } },
      { name: "g", help: "a gauge", value: 2, labels: { a: "2" } },
    ]);
    expect(text).toContain('x_total{name="quote \\" back \\\\ line\\nbreak"} 1');
    expect(text.split("# HELP g a gauge").length).toBe(2);
    expect(text).toContain('g{a="1"} 1.5');
    expect(text).toContain('g{a="2"} 2');
    const lines = text.trim().split("\n");
    expect(lines.at(-1)).toMatch(/^dbportal_uptime_seconds \d+$/);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("a registered gauge is read at scrape time, re-registering replaces it, and a reader that throws is skipped", () => {
    let size = 1;
    registerGauge("dbportal_providers_cached", "Database providers held open in this process.", () => size);
    expect(renderMetrics()).toContain("dbportal_providers_cached 1");
    size = 4;
    expect(renderMetrics()).toContain("dbportal_providers_cached 4");
    registerGauge("dbportal_providers_cached", "replaced", () => 9);
    const text = renderMetrics();
    expect(text).toContain("# HELP dbportal_providers_cached replaced");
    expect(text).toContain("dbportal_providers_cached 9");
    registerGauge("broken", "never answers", () => {
      throw new Error("no");
    });
    expect(renderMetrics()).not.toContain("broken");
  });

  test("a registry left by an older module instance without a gauge map is repaired, not a failed scrape", () => {
    const holder = globalThis as unknown as Record<symbol, unknown>;
    holder[Symbol.for("dbportal.metrics")] = { startedAt: Date.now(), counters: new Map(), histograms: new Map() };
    registerGauge("g", "gauge", () => 2);
    expect(renderMetrics()).toContain("g 2");
  });

  test("an empty registry renders only the uptime gauge", () => {
    const text = renderMetrics();
    expect(text).toContain("# TYPE dbportal_uptime_seconds gauge");
    expect(text).not.toContain("counter");
  });
});
