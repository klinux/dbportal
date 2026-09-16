/**
 * `extraSecretEnv` (docs/CONTEXT.md §4.45): environment variables the chart has no field
 * for, handed over as a Secret rather than in the pod spec. A default render writes no such
 * Secret and no reference to it, so an existing install is byte for byte what it was; with
 * the block set, one Secret carries the values base64-encoded, every role Deployment
 * attaches it with envFrom after the ConfigMap, and the pod template hashes it so a rotated
 * value rolls the pods. A name that is not an environment variable name is refused by the
 * schema. Exercises real `helm template` output.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/dbportal");
const JWT = "not-a-secret-helm-template-fixture-value";
const ROLES = [
  "config.storageProvider=postgres",
  "secrets.storagePostgresUrl=postgres://u:p@h/db",
  "workers.enabled=true",
  "agentRole.enabled=true",
];

type Doc = {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: {
    template: {
      metadata: { annotations: Record<string, string> };
      spec: { containers: { envFrom: { configMapRef?: { name: string }; secretRef?: { name: string } }[] }[] };
    };
  };
};
function render(...sets: string[]): Doc[] {
  const args = ["template", "t", CHART_DIR, "--set", `secrets.jwtSecret=${JWT}`, ...sets.flatMap((s) => ["--set", s])];
  return parseAllDocuments(execFileSync("helm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).map(
    (d) => d.toJSON() as Doc,
  );
}
const deployments = (docs: Doc[]) => docs.filter((d) => d?.kind === "Deployment");
const secretRefs = (d: Doc) => d.spec!.template.spec.containers[0].envFrom.flatMap((e) => (e.secretRef ? [e.secretRef.name] : []));

describe("helm chart: extraSecretEnv", () => {
  test("a default render writes no extra-env Secret, no envFrom reference and no checksum", () => {
    const docs = render();
    expect(docs.find((d) => d?.kind === "Secret" && d.metadata?.name === "t-dbportal-extra-env")).toBeUndefined();
    for (const d of deployments(docs)) {
      expect(secretRefs(d)).toEqual([]);
      expect(d.spec!.template.metadata.annotations["checksum/extra-secret-env"]).toBeUndefined();
    }
  });

  test("the values land base64-encoded in one Secret that every role attaches after the ConfigMap", () => {
    const docs = render(...ROLES, "extraSecretEnv.METRICS_TOKEN=scrape-me", "extraSecretEnv.ORDERS_DB_PASSWORD=p w");
    const secret = docs.find((d) => d?.kind === "Secret" && d.metadata?.name === "t-dbportal-extra-env");
    // Encoded the way the release's own Secret is, so a GitOps tool that resolves
    // placeholders in Secret data treats both alike.
    expect(secret?.data).toEqual({
      METRICS_TOKEN: Buffer.from("scrape-me").toString("base64"),
      ORDERS_DB_PASSWORD: Buffer.from("p w").toString("base64"),
    });
    const names = deployments(docs).map((d) => d.metadata?.name).sort();
    expect(names).toEqual(["t-dbportal", "t-dbportal-agent", "t-dbportal-workers"]);
    for (const d of deployments(docs)) {
      // The ConfigMap first, so nothing in the Secret is shadowed by a plain setting.
      const envFrom = d.spec!.template.spec.containers[0].envFrom;
      expect(envFrom[0].configMapRef?.name).toBe("t-dbportal-config");
      expect(secretRefs(d)).toEqual(["t-dbportal-extra-env"]);
    }
  });

  test("a changed value changes the checksum, so the pods roll", () => {
    const first = deployments(render("extraSecretEnv.METRICS_TOKEN=one"))[0];
    const second = deployments(render("extraSecretEnv.METRICS_TOKEN=two"))[0];
    const a = first.spec!.template.metadata.annotations["checksum/extra-secret-env"];
    const b = second.spec!.template.metadata.annotations["checksum/extra-secret-env"];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  test("a name that is not an environment variable name is refused by the schema", () => {
    let stderr = "";
    try {
      render("extraSecretEnv.not-a-name=x");
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? error);
    }
    // Helm reports the failing property and the pattern, not the block it sits in.
    expect(stderr).toContain("'not-a-name' does not match pattern");
  });
});
