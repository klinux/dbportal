/**
 * The roles a single release renders beside the studio (docs/CONTEXT.md §4.40): `workers`
 * and `agentRole`. A default render is one Deployment, byte for byte what it was. With the
 * blocks on, the release renders one Deployment per role from the same pod template - the
 * same image, ConfigMap and Secret - each with a name label of its own so no selector of
 * the studio's matches its pods; the studio then only enqueues; the agent gets a Service
 * and an emptyDir of its own; KEDA targets the workers Deployment while the HPA keeps the
 * studio; a network policy renders per Deployment. What cannot work is refused: workers
 * without a PostgreSQL store, or on a persistent volume that is not ReadWriteMany.
 * Exercises real `helm template` output.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/dbportal");
const JWT = "not-a-secret-helm-template-fixture-value";
const PG = ["config.storageProvider=postgres", "secrets.storagePostgresUrl=postgres://u:p@h/db"];

type Doc = { kind?: string; metadata?: { name?: string; labels?: Record<string, string> }; spec?: never };
function render(...sets: string[]): Doc[] {
  const args = ["template", "t", CHART_DIR, "--set", `secrets.jwtSecret=${JWT}`, ...sets.flatMap((s) => ["--set", s])];
  return parseAllDocuments(execFileSync("helm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).map(
    (d) => d.toJSON() as Doc,
  );
}
const named = (docs: Doc[], kind: string, name: string) =>
  docs.find((d) => d?.kind === kind && d.metadata?.name === name) as never;
const refusal = (...sets: string[]): string => {
  try {
    render(...sets);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
};
type Deployment = {
  spec: {
    replicas?: number;
    selector: { matchLabels: Record<string, string> };
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        containers: { env: { name: string; value?: string }[]; envFrom: unknown[]; resources: unknown }[];
        volumes: { name: string; emptyDir?: object; persistentVolumeClaim?: object }[];
      };
    };
  };
};
const env = (d: Deployment, name: string) => d.spec.template.spec.containers[0].env.find((e) => e.name === name);

describe("helm chart: roles beside the studio", () => {
  test("a default render is one Deployment and no role objects", () => {
    const docs = render();
    expect(docs.filter((d) => d?.kind === "Deployment").map((d) => d.metadata?.name)).toEqual(["t-dbportal"]);
    expect(docs.filter((d) => d?.kind === "Service").map((d) => d.metadata?.name)).toEqual(["t-dbportal"]);
  });

  test("workers.enabled renders the workers Deployment from the same template, with its own name label, and the studio only enqueues", () => {
    const docs = render("workers.enabled=true", ...PG);
    const studio = named(docs, "Deployment", "t-dbportal") as Deployment;
    const workers = named(docs, "Deployment", "t-dbportal-workers") as Deployment;
    expect(workers.spec.replicas).toBe(1);
    expect(workers.spec.selector.matchLabels).toEqual({
      "app.kubernetes.io/name": "dbportal-worker",
      "app.kubernetes.io/instance": "t",
    });
    expect(workers.spec.template.metadata.labels["app.kubernetes.io/component"]).toBe("worker");
    expect(env(workers, "DBPORTAL_ROLE")).toEqual({ name: "DBPORTAL_ROLE", value: "worker" });
    expect(env(workers, "JOBS_WORKER")).toBeUndefined();
    // The same ConfigMap and Secret: the workers' envFrom and JWT reference are the studio's.
    expect(workers.spec.template.spec.containers[0].envFrom).toEqual(studio.spec.template.spec.containers[0].envFrom);
    expect(env(workers, "STORAGE_POSTGRES_URL")).toEqual(env(studio, "STORAGE_POSTGRES_URL"));
    // The studio keeps its selector (immutable) and no worker pod matches it or its Service.
    expect(studio.spec.selector.matchLabels).toEqual({
      "app.kubernetes.io/name": "dbportal",
      "app.kubernetes.io/instance": "t",
    });
    expect(env(studio, "DBPORTAL_ROLE")).toBeUndefined();
    expect(env(studio, "JOBS_WORKER")).toEqual({ name: "JOBS_WORKER", value: "off" });
    // The operator's own word on the loop wins over the default the workers imply.
    const told = named(render("workers.enabled=true", "config.jobsWorker=auto", ...PG), "Deployment", "t-dbportal");
    expect(env(told as Deployment, "JOBS_WORKER")).toBeUndefined();
    // Resources: the workers' own when given, the release's otherwise.
    expect(workers.spec.template.spec.containers[0].resources).toEqual(
      studio.spec.template.spec.containers[0].resources,
    );
    const sized = named(
      render("workers.enabled=true", "workers.resources.requests.cpu=2", "workers.replicaCount=3", ...PG),
      "Deployment",
      "t-dbportal-workers",
    ) as Deployment;
    expect(sized.spec.template.spec.containers[0].resources).toEqual({ requests: { cpu: 2 } });
    expect(sized.spec.replicas).toBe(3);
  });

  test("agentRole.enabled renders the agent Deployment with a Service and an emptyDir of its own", () => {
    const docs = render("agentRole.enabled=true", "persistence.enabled=true", ...PG);
    const agent = named(docs, "Deployment", "t-dbportal-agent") as Deployment;
    expect(env(agent, "DBPORTAL_ROLE")).toEqual({ name: "DBPORTAL_ROLE", value: "agent" });
    expect(agent.spec.template.spec.volumes.find((v) => v.name === "data")).toEqual({ name: "data", emptyDir: {} });
    const studio = named(docs, "Deployment", "t-dbportal") as Deployment;
    expect(studio.spec.template.spec.volumes.find((v) => v.name === "data")?.persistentVolumeClaim).toBeDefined();
    const service = named(docs, "Service", "t-dbportal-agent") as {
      spec: { selector: Record<string, string>; ports: { port: number; targetPort: number }[]; type: string };
    };
    expect(service.spec.selector["app.kubernetes.io/name"]).toBe("dbportal-agent");
    expect(service.spec.ports[0]).toMatchObject({ port: 80, targetPort: 3000 });
    expect(service.spec.type).toBe("ClusterIP");
  });

  test("KEDA targets the workers Deployment and the HPA keeps the studio; a policy renders per Deployment", () => {
    const docs = render(
      "workers.enabled=true",
      "agentRole.enabled=true",
      "keda.enabled=true",
      "autoscaling.enabled=true",
      "networkPolicy.enabled=true",
      ...PG,
    );
    const scaled = named(docs, "ScaledObject", "t-dbportal") as { spec: { scaleTargetRef: { name: string } } };
    expect(scaled.spec.scaleTargetRef.name).toBe("t-dbportal-workers");
    const hpa = named(docs, "HorizontalPodAutoscaler", "t-dbportal") as { spec: { scaleTargetRef: { name: string } } };
    expect(hpa.spec.scaleTargetRef.name).toBe("t-dbportal");
    expect("replicas" in (named(docs, "Deployment", "t-dbportal-workers") as Deployment).spec).toBe(false);
    expect("replicas" in (named(docs, "Deployment", "t-dbportal") as Deployment).spec).toBe(false);
    const policies = docs
      .filter((d) => d?.kind === "NetworkPolicy")
      .map((d) => d.metadata?.name)
      .sort();
    expect(policies).toEqual(["t-dbportal", "t-dbportal-agent", "t-dbportal-workers"]);
    const workersPolicy = named(docs, "NetworkPolicy", "t-dbportal-workers") as {
      spec: { podSelector: { matchLabels: Record<string, string> } };
    };
    expect(workersPolicy.spec.podSelector.matchLabels["app.kubernetes.io/name"]).toBe("dbportal-worker");
  });

  test("refused: workers without a PostgreSQL store, or on a persistent volume that is not ReadWriteMany", () => {
    expect(refusal("workers.enabled=true")).toContain("storageProvider=postgres");
    expect(refusal("workers.enabled=true", "persistence.enabled=true", ...PG)).toContain("ReadWriteMany");
    const shared = render(
      "workers.enabled=true",
      "persistence.enabled=true",
      "persistence.accessModes[0]=ReadWriteMany",
      ...PG,
    );
    expect(
      (named(shared, "Deployment", "t-dbportal-workers") as Deployment).spec.template.spec.volumes.find(
        (v) => v.name === "data",
      )?.persistentVolumeClaim,
    ).toBeDefined();
  });
});
