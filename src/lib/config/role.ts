/**
 * The deployment's role (docs/CONTEXT.md §4.30). One image, two roles: `studio` - the
 * portal as it always was - and `agent`, a second deployment that serves only the surfaces
 * a program calls with a service token (the bot API of §4.10 and the MCP endpoint), the
 * probes and the scrape. Everything else - the pages, the session routes, the admin API,
 * the studio's own datasources and store writes - is refused there, so a compromise of the
 * agent runtime reaches what its tokens reach and no more. The role is read per request,
 * not cached: it is an environment variable set once at deploy time, and reading it is free.
 */
export type DeploymentRole = "studio" | "agent";

export function deploymentRole(): DeploymentRole {
  return process.env.DBPORTAL_ROLE?.trim().toLowerCase() === "agent" ? "agent" : "studio";
}

export function isAgentRole(): boolean {
  return deploymentRole() === "agent";
}

/** The service API (§4.10) and the MCP endpoint (§4.30): what a program calls with a Bearer. */
export const SERVICE_API_PREFIX = "/api/v1/";
export const MCP_PATH = "/api/mcp";

/** What the agent role still answers: the two program surfaces, the probes, the scrape. */
export function agentRoleAdmits(pathname: string): boolean {
  return (
    pathname.startsWith(SERVICE_API_PREFIX) ||
    pathname === MCP_PATH ||
    pathname === "/api/health/live" ||
    pathname === "/api/health/ready" ||
    pathname === "/api/db/health" ||
    pathname === "/api/metrics"
  );
}
