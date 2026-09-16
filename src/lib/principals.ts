import { listSharedDatasources } from "@/lib/datasources/store";
import { listSeenPrincipals } from "@/lib/principals-seen";
import { listNamedRoles } from "@/lib/roles/store";
import { loadConfig } from "@/lib/seed/config-loader";
import { listServiceTokens } from "@/lib/service-tokens/store";
import { type KnownPrincipal, principalKind } from "@/lib/principal-kind";

/**
 * The principals this deployment already knows (docs/CONTEXT.md §4.37, asked 2026-09-14):
 * what an administrator can pick from instead of typing - the wildcard and the two portal
 * roles, every named role as `role:<id>`, every group and person already named anywhere
 * (a datasource's lists, a named role's members, a service token's groups), and every
 * person and group seen signing in (§4.49). Not a directory: a group the identity provider
 * has never sent for anyone is typed once and then known.
 */
export { principalKind, type KnownPrincipal, type PrincipalKind } from "@/lib/principal-kind";

export async function listKnownPrincipals(): Promise<KnownPrincipal[]> {
  const seen = new Map<string, KnownPrincipal>();
  const add = (id: string, source: string) => {
    const kind = principalKind(id);
    if (kind && !seen.has(id)) seen.set(id, { id, kind, source });
  };
  add("*", "built-in");
  add("admin", "built-in");
  add("user", "built-in");
  for (const { role } of await listNamedRoles()) {
    add(`role:${role.id}`, `role ${role.name}`);
    for (const member of role.members) add(member, `role ${role.name}`);
  }
  const config = await loadConfig();
  for (const conn of config?.connections ?? []) {
    for (const id of [
      ...conn.roles,
      ...(conn.writeRoles ?? []),
      ...(conn.approverRoles ?? []),
      ...(conn.exportRoles ?? []),
    ]) {
      add(id, `datasource ${conn.id}`);
    }
  }
  for (const conn of await listSharedDatasources().catch(() => [])) {
    for (const id of [
      ...conn.roles,
      ...(conn.writeRoles ?? []),
      ...(conn.approverRoles ?? []),
      ...(conn.exportRoles ?? []),
    ]) {
      add(id, `datasource ${conn.id}`);
    }
  }
  for (const token of await listServiceTokens().catch(() => [])) {
    for (const group of token.groups ?? []) add(`group:${group}`, `token ${token.name}`);
  }
  for (const principal of await listSeenPrincipals().catch(() => [])) add(principal.id, "signed in");
  return [...seen.values()];
}
