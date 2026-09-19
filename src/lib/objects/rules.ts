/**
 * Which objects of a datasource each person sees and may name (docs/CONTEXT.md §4.56).
 *
 * A datasource may carry `objects`: rules of `match` (a name pattern) and `roles` (the
 * principal vocabulary of `roles`, §4.4). With no rule the datasource is what it always
 * was, every object for everyone who can open it. With rules, a person sees exactly the
 * objects some rule THEY HOLD matches, and nothing else - and may name in a statement
 * only those. An administrator sees everything: the rules are theirs to manage, and a
 * rule that hid an object from the one person who can fix it would hide the mistake too.
 *
 * Pure, and shared by the server (visibility, the execution gate) and the browser (the
 * admin form's hints), so nothing here reads a store or a session store.
 *
 * A pattern is matched, case-insensitively, against an object's dotted path - the
 * container segments then the object segments, `public.orders`, `smb.customers`,
 * `apim-2026.09` - with `*` for any run of characters (dots included) and `?` for one.
 * A pattern with no dot is matched against the relation's own name instead, in every
 * container: `orders` is `public.orders` and `audit.orders` alike, which is what an
 * administrator writing a rule on a search cluster (no containers at all) or on a
 * database with one schema means by it. A rule that matches an object also covers what
 * nests under it - a trigger of a visible table is visible - because the child's path
 * starts with the parent's.
 */
import { type AccessSession, matchesAccess, principalsOf } from "@/lib/access";

export interface ObjectRule {
  /** The pattern; see the module comment for its grammar. */
  readonly match: string;
  /** Who the rule applies to, in the vocabulary of a datasource's `roles`. */
  readonly roles: readonly string[];
}

/** A pattern: no whitespace, no comma (the list separator an admin would reach for), bounded. */
export const OBJECT_PATTERN = /^[^\s,]{1,200}$/u;

/** At most this many rules on one datasource; a longer list is a policy engine, not a datasource field. */
export const OBJECT_RULES_LIMIT = 100;

/**
 * What one session may see of one datasource: everything, or exactly the patterns of the
 * rules it holds (possibly none, which is nothing).
 */
export type ObjectScope =
  | { readonly restricted: false }
  | { readonly restricted: true; readonly patterns: readonly string[] };

export const UNRESTRICTED: ObjectScope = Object.freeze({ restricted: false });

export function objectScopeFor(rules: readonly ObjectRule[] | undefined, session: AccessSession): ObjectScope {
  if (rules === undefined || rules.length === 0 || session.role === "admin") return UNRESTRICTED;
  const principals = principalsOf(session);
  return {
    restricted: true,
    patterns: rules.filter((rule) => matchesAccess(rule.roles, principals)).map((rule) => rule.match),
  };
}

/** Whether a scope with rules holds any pattern with a container part in it. */
export function hasQualifiedPattern(scope: ObjectScope): boolean {
  return scope.restricted && scope.patterns.some((pattern) => pattern.includes("."));
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** The pattern as a whole-string, case-insensitive regular expression. */
export function patternRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((run) =>
      run
        .split("?")
        .map((literal) => literal.replace(REGEX_SPECIALS, "\\$&"))
        .join("."),
    )
    .join(".*");
  return new RegExp(`^${source}$`, "iu");
}

const PATH_SEPARATOR = ".";

/**
 * Whether the scope shows the object at `path` - the container segments (as many as the
 * provider declares, `depth`) followed by the object's own segments. A pattern with a
 * dot is tried against the object's dotted path and against every object-level ancestor's
 * (a trigger under a matched table is shown with the table); a pattern without one is
 * tried against the relation's name, the first segment after the containers.
 */
export function pathVisible(scope: ObjectScope, path: readonly string[], depth: number): boolean {
  if (!scope.restricted) return true;
  if (path.length <= depth) return false;
  const relation = path[depth];
  return scope.patterns.some((pattern) => {
    const regex = patternRegex(pattern);
    if (!pattern.includes(PATH_SEPARATOR)) return regex.test(relation);
    for (let end = depth + 1; end <= path.length; end += 1) {
      if (regex.test(path.slice(0, end).join(PATH_SEPARATOR))) return true;
    }
    return false;
  });
}

/** One object a statement names: an optional qualifier (`schema`, or `catalog.schema`) and the name. */
export interface ObjectReference {
  readonly qualifier: readonly string[];
  readonly name: string;
}

/**
 * Why a reference is not covered by the scope, or null when it is. Distinguished so a
 * refusal can say what to do: qualify the name, or drop the wildcard.
 */
export type ReferenceVerdict = "hidden" | "unqualified" | "wildcard" | null;

/**
 * Whether a session may name `reference` in a statement.
 *
 * An unqualified name is judged in the session's default container when the provider
 * reports one; when it reports none and the scope has a qualified pattern, the name
 * cannot be placed and is refused with the reason - the alternative, guessing a
 * container, is guessing an access decision. A name with a wildcard in it (a search
 * cluster's `logs-*`) names objects no rule was checked against, and is refused as such.
 */
export function referenceVerdict(
  scope: ObjectScope,
  reference: ObjectReference,
  defaultContainer: readonly string[] | undefined,
  depth: number,
): ReferenceVerdict {
  if (!scope.restricted) return null;
  if (reference.name.includes("*") || reference.qualifier.some((segment) => segment.includes("*"))) return "wildcard";
  if (reference.qualifier.length > 0) {
    return pathVisible(scope, [...reference.qualifier, reference.name], depth) ? null : "hidden";
  }
  if (depth === 0) return pathVisible(scope, [reference.name], 0) ? null : "hidden";
  if (defaultContainer !== undefined && defaultContainer.length === depth) {
    return pathVisible(scope, [...defaultContainer, reference.name], depth) ? null : "hidden";
  }
  // Only the unqualified patterns can judge a name with no container to put it in.
  const bare: ObjectScope = { restricted: true, patterns: scope.patterns.filter((p) => !p.includes(PATH_SEPARATOR)) };
  if (pathVisible(bare, [reference.name], 0)) return null;
  return hasQualifiedPattern(scope) ? "unqualified" : "hidden";
}

/** A reference as a person reads it, for a refusal. */
export function referenceLabel(reference: ObjectReference): string {
  return [...reference.qualifier, reference.name].join(PATH_SEPARATOR);
}
