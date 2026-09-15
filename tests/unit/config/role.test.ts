import { describe, test, expect, afterEach } from "bun:test";
import { agentRoleAdmits, deploymentRole, isAgentRole, MCP_PATH, roleAdmits } from "@/lib/config/role";

/** The deployment's role (docs/CONTEXT.md §4.30): studio unless told `agent`, and what the agent role still answers. */
const saved = process.env.DBPORTAL_ROLE;

describe("deployment role", () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.DBPORTAL_ROLE;
    else process.env.DBPORTAL_ROLE = saved;
  });

  test("studio by default and for any other word; agent when said so, whatever the case", () => {
    delete process.env.DBPORTAL_ROLE;
    expect(deploymentRole()).toBe("studio");
    process.env.DBPORTAL_ROLE = "worker";
    expect(isAgentRole()).toBe(false);
    process.env.DBPORTAL_ROLE = " Agent ";
    expect(deploymentRole()).toBe("agent");
    expect(isAgentRole()).toBe(true);
    process.env.DBPORTAL_ROLE = "worker";
    expect(deploymentRole()).toBe("worker");
    expect(isAgentRole()).toBe(false);
  });

  test("the agent role admits the service API, the MCP endpoint, the probes and the scrape, and nothing else", () => {
    for (const path of [
      "/api/v1/executions",
      "/api/v1/executions/x",
      MCP_PATH,
      "/api/health/live",
      "/api/health/ready",
      "/api/db/health",
      "/api/metrics",
    ]) {
      expect(agentRoleAdmits(path)).toBe(true);
    }
    for (const path of [
      "/",
      "/login",
      "/api/auth/login",
      "/api/db/query",
      "/admin/datasources",
      "/api/admin/datasources",
      "/api/mcp/x",
      "/api/v1",
    ]) {
      expect(agentRoleAdmits(path)).toBe(false);
    }
  });

  // docs/CONTEXT.md §4.40: the worker role answers the probes and the scrape, nothing else; the studio everything.
  test("roleAdmits per role", () => {
    expect(roleAdmits("studio", "/admin")).toBe(true);
    expect(roleAdmits("agent", MCP_PATH)).toBe(true);
    expect(roleAdmits("agent", "/admin")).toBe(false);
    expect(roleAdmits("worker", "/api/health/ready")).toBe(true);
    expect(roleAdmits("worker", "/api/metrics")).toBe(true);
    expect(roleAdmits("worker", MCP_PATH)).toBe(false);
    expect(roleAdmits("worker", "/api/v1/executions")).toBe(false);
    expect(roleAdmits("worker", "/")).toBe(false);
  });
});
