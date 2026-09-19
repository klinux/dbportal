/**
 * The execution routes' object gate (docs/CONTEXT.md §4.56): the statements a request
 * carries are refused when one names an object the datasource's rules keep from this
 * session, audited as `object_forbidden`, the way the write gate refuses a write on a
 * read-only datasource. Sits beside `assertWriteAllowed`, after the provider exists,
 * because placing an unqualified name needs the session's default container.
 */
import type { AccessSession } from "@/lib/access";
import { enumerateContainers } from "@/lib/db/container-walk";
import { containerDepth } from "@/lib/db/object-kinds";
import type { DatabaseProvider } from "@/lib/db/types";
import { auditRoleDenial } from "@/lib/api/role-denial";
import { objectRefusal } from "@/lib/objects/gate";
import { type ObjectRule, objectScopeFor, pathVisible } from "@/lib/objects/rules";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { DatabaseConnection } from "@/lib/types";

/** The session as every execution path has it: a person's, or a service token's. */
type GateSession = AccessSession & { username: string };

/** The resolved connection; a client-supplied one carries no rules and passes. */
type RuledConnection = DatabaseConnection & { objectRules?: readonly ObjectRule[] };

export async function assertObjectsAllowed(opts: {
  route: string;
  session: GateSession;
  connection: RuledConnection;
  statements: readonly string[];
  /** Absent on a worker, which has no request to read an address from. */
  request?: Request;
  provider: DatabaseProvider;
}): Promise<void> {
  const scope = objectScopeFor(opts.connection.objectRules, opts.session);
  if (!scope.restricted) return;
  const refusal = await objectRefusal({
    scope,
    statements: opts.statements,
    type: opts.connection.type,
    datasourceName: opts.connection.name,
    depth: containerDepth(opts.provider.getCapabilities()),
    defaultContainer: async () => (await enumerateContainers(opts.provider)).defaultContainer,
  });
  if (refusal === null) return;
  auditRoleDenial({ route: opts.route, user: opts.session.username, request: opts.request, reason: "object_forbidden" });
  throw new SeedConnectionError(refusal, 403);
}

/**
 * The same gate for a read that names an object by its ADDRESS rather than in a statement
 * (the profiler): a hidden object is refused as the statement gate would refuse a
 * statement naming it, and audited the same way.
 */
interface ObjectAddressGate {
  route: string;
  session: GateSession;
  connection: RuledConnection;
  path: readonly string[];
  request?: Request;
  provider: DatabaseProvider;
}

export function assertObjectVisible(opts: ObjectAddressGate): void {
  const scope = objectScopeFor(opts.connection.objectRules, opts.session);
  if (pathVisible(scope, opts.path, containerDepth(opts.provider.getCapabilities()))) return;
  auditRoleDenial({ route: opts.route, user: opts.session.username, request: opts.request, reason: "object_forbidden" });
  throw new SeedConnectionError(`"${opts.path.join(".")}" is not an object you may use on "${opts.connection.name}".`, 403);
}
