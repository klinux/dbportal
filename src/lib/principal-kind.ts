/**
 * The vocabulary of a principal id, shared by the server list (`@/lib/principals`) and the
 * picker in the browser. Kept apart from the list so the client bundle never pulls the
 * stores behind it (docs/CONTEXT.md §4.37).
 */
export type PrincipalKind = "wildcard" | "role" | "named" | "group" | "user";

export interface KnownPrincipal {
  id: string;
  kind: PrincipalKind;
  /** Where it was seen first, for the picker's hint. */
  source: string;
}

export function principalKind(id: string): PrincipalKind | null {
  if (id === "*") return "wildcard";
  if (id === "admin" || id === "user") return "role";
  if (id.startsWith("role:")) return "named";
  if (id.startsWith("group:")) return "group";
  if (id.startsWith("user:")) return "user";
  return null;
}
