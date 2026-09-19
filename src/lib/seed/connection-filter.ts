import type { SSLConfig } from "@/lib/types";
import type { SeedConnection, SeedDefaults, ManagedConnection } from "./types";

export function mergeDefaults(conn: SeedConnection, defaults: SeedDefaults | undefined): SeedConnection {
  if (!defaults) return conn;
  return {
    ...conn,
    managed: conn.managed ?? defaults.managed,
    environment: conn.environment ?? defaults.environment,
    ssl: conn.ssl ?? defaults.ssl,
  };
}

function rolesMatch(connectionRoles: string[], userRoles: string[]): boolean {
  if (connectionRoles.includes("*")) return true;
  return connectionRoles.some((r) => userRoles.includes(r));
}

/** Who may open a virtual datasource (§4.44): whoever may open every member; a missing member closes it. */
function virtualOpens(conn: SeedConnection, all: SeedConnection[], userRoles: string[]): boolean {
  return (conn.members ?? []).every((id) => {
    const member = all.find((c) => c.id === id);
    // A member with object rules is refused at declaration time (§4.56); a stored one that
    // acquired rules later closes the virtual datasource rather than bypassing them.
    return member !== undefined && rolesMatch(member.roles, userRoles) && !(member.objects && member.objects.length > 0);
  });
}

export function filterByRoles(connections: SeedConnection[], userRoles: string[]): ManagedConnection[] {
  return connections
    .filter((conn) =>
      conn.type === "virtual"
        ? rolesMatch(conn.roles, userRoles) && virtualOpens(conn, connections, userRoles)
        : rolesMatch(conn.roles, userRoles),
    )
    .map((conn) => ({
      id: `seed:${conn.id}`,
      name: conn.name,
      type: conn.type,
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      connectionString: conn.connectionString,
      environment: conn.environment,
      group: conn.group,
      color: conn.color,
      ssl: conn.ssl as SSLConfig | undefined,
      serviceName: conn.serviceName,
      instanceName: conn.instanceName,
      // Cassandra's required data centre. Dropping it here would list a seeded ring
      // the product cannot open, because the driver refuses to connect without one.
      localDataCenter: conn.localDataCenter,
      // MongoDB's auth database. Dropping it here would list a seeded connection that
      // authenticates against the wrong database and reports a credentials error.
      authSource: conn.authSource,
      // Athena's address and its two run settings. Dropping the region here would list
      // a seeded connection the provider refuses to construct at all.
      region: conn.region,
      workgroup: conn.workgroup,
      outputLocation: conn.outputLocation,
      schema: conn.schema,
      // The second half of the seed round-trip, and the half a zod field cannot cover:
      // this mapper is a hand-written field list, so a field validated above and not
      // copied here reaches the browser as `undefined` and the seeded connection scans
      // the catalog the deployment asked it not to (#765).
      skipObjectScan: conn.skipObjectScan,
      createdAt: new Date(),
      managed: conn.managed ?? true,
      roles: conn.roles,
      ...(conn.writeRoles !== undefined ? { writeRoles: conn.writeRoles } : {}),
      ...(conn.writeApproval !== undefined ? { writeApproval: conn.writeApproval } : {}),
      ...(conn.guardrails !== undefined ? { guardrails: conn.guardrails } : {}),
      // The datasource's limits (§4.16); its timeout is also the connection's, which is the
      // field the provider factory reads.
      ...(conn.limits !== undefined ? { limits: conn.limits } : {}),
      ...(conn.limits?.queryTimeoutMs !== undefined ? { queryTimeout: conn.limits.queryTimeoutMs } : {}),
      ...(conn.requireTicket !== undefined ? { requireTicket: conn.requireTicket } : {}),
      ...(conn.exportRoles !== undefined ? { exportRoles: conn.exportRoles } : {}),
      // The object rules (§4.56) travel with the connection so the object routes, the
      // execution gate and the agent all judge from one declaration; an empty list is
      // no rule, so the datasource stays unrestricted rather than hiding everything.
      ...(conn.objects !== undefined && conn.objects.length > 0 ? { objectRules: conn.objects } : {}),
      ...(conn.approverRoles !== undefined ? { approverRoles: conn.approverRoles } : {}),
      ...(conn.approvalsRequired !== undefined ? { approvalsRequired: conn.approvalsRequired } : {}),
      ...(conn.sshProfile !== undefined ? { sshProfile: conn.sshProfile } : {}),
      seedId: conn.id,
      // A virtual datasource (§4.44) writes nothing, for anyone, and exports only where
      // every member would: the rules travel with it so the one export gate can ask.
      ...(conn.type === "virtual"
        ? {
            members: conn.members,
            writeRoles: [],
            memberExportRules: (conn.members ?? []).map((id) => {
              const member = connections.find((c) => c.id === id);
              return { environment: member?.environment ?? conn.environment, exportRoles: member?.exportRoles };
            }),
          }
        : {}),
    }));
}
