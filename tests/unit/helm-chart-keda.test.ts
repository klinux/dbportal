/**
 * The chart's `keda` block (docs/CONTEXT.md §4.40): a ScaledObject that scales the worker
 * release on the queue's depth. A default render writes none; `keda.enabled` on a worker
 * release with the queue in PostgreSQL renders one with a Prometheus trigger on
 * dbportal_jobs_queued and takes the Deployment's replicas line away, since the scaler
 * owns the count; on any other role, together with the HPA, or without a shared store the
 * render is refused with a message that names the fix. Exercises real `helm template` output.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/dbportal");
const JWT = "not-a-secret-helm-template-fixture-value";
const SHARED = ["config.storageProvider=postgres", "secrets.storagePostgresUrl=postgres://u:p@h/db"];

function render(...sets: string[]): Record<string, unknown>[] {
  const args = ["template", "t", CHART_DIR, "--set", `secrets.jwtSecret=${JWT}`, ...sets.flatMap((s) => ["--set", s])];
  return parseAllDocuments(execFileSync("helm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).map(
    (d) => d.toJSON() as Record<string, unknown>,
  );
}
const ofKind = (docs: Record<string, unknown>[], kind: string) => docs.find((d) => d?.kind === kind) as never;
const refusal = (...sets: string[]): string => {
  try {
    render(...sets);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
};

describe("helm chart: keda", () => {
  test("a default render, and a worker without keda, write no ScaledObject and keep the replicas line", () => {
    expect(ofKind(render(), "ScaledObject")).toBeUndefined();
    const worker = render("role=worker", ...SHARED);
    expect(ofKind(worker, "ScaledObject")).toBeUndefined();
    expect((ofKind(worker, "Deployment") as { spec: { replicas: number } }).spec.replicas).toBe(1);
  });

  test("keda.enabled on a worker release renders the trigger on the queue's gauge and hands the count to KEDA", () => {
    const docs = render("role=worker", "keda.enabled=true", ...SHARED);
    const scaled = ofKind(docs, "ScaledObject") as {
      spec: {
        scaleTargetRef: { name: string };
        minReplicaCount: number;
        maxReplicaCount: number;
        triggers: { type: string; metadata: Record<string, string>; authenticationRef?: { name: string } }[];
      };
    };
    expect(scaled.spec.scaleTargetRef.name).toBe("t-dbportal");
    expect(scaled.spec).toMatchObject({ minReplicaCount: 1, maxReplicaCount: 10 });
    expect(scaled.spec.triggers).toEqual([
      {
        type: "prometheus",
        metadata: {
          serverAddress: "http://prometheus-server.monitoring.svc:9090",
          query: 'max(dbportal_jobs_queued{namespace="default"})',
          threshold: "5",
        },
      },
    ]);
    expect("replicas" in (ofKind(docs, "Deployment") as { spec: object }).spec).toBe(false);
    const tuned = ofKind(
      render(
        "role=worker",
        "keda.enabled=true",
        "keda.query=sum(x)",
        "keda.minReplicas=0",
        "keda.queuedPerReplica=2",
        "keda.authenticationRef=prom-token",
        ...SHARED,
      ),
      "ScaledObject",
    ) as { spec: { minReplicaCount: number; triggers: { metadata: Record<string, string>; authenticationRef?: object }[] } };
    expect(tuned.spec.minReplicaCount).toBe(0);
    expect(tuned.spec.triggers[0].metadata).toMatchObject({ query: "sum(x)", threshold: "2" });
    expect(tuned.spec.triggers[0].authenticationRef).toEqual({ name: "prom-token" });
  });

  test("config.jobsWorker writes JOBS_WORKER only when set, and takes the two words alone", () => {
    const data = (docs: Record<string, unknown>[]) => (ofKind(docs, "ConfigMap") as { data: Record<string, string> }).data;
    expect("JOBS_WORKER" in data(render())).toBe(false);
    expect(data(render("config.jobsWorker=off")).JOBS_WORKER).toBe("off");
    expect(data(render("config.jobsWorker=auto")).JOBS_WORKER).toBe("auto");
    expect(refusal("config.jobsWorker=maybe")).not.toBe("");
  });

  test("refused on another role, together with the HPA, without a shared store, and with a value off the schema", () => {
    expect(refusal("keda.enabled=true", ...SHARED)).toContain("role=worker");
    expect(refusal("role=worker", "keda.enabled=true", "autoscaling.enabled=true", ...SHARED)).toContain(
      "autoscaling.enabled",
    );
    expect(refusal("role=worker", "keda.enabled=true")).toContain("storageProvider=postgres");
    expect(refusal("role=worker", "keda.enabled=true", "keda.queuedPerReplica=0", ...SHARED)).not.toBe("");
  });
});
