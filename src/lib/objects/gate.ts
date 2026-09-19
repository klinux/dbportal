/**
 * The refusal an object scope gives a statement, if any (docs/CONTEXT.md §4.56).
 *
 * Visibility hides an object from the tree; this is what keeps a statement from naming
 * it anyway. Every relation the statement reaches for (`referenced-objects.ts`) is
 * judged by the scope, and the first one outside it names the refusal - with what to
 * do about it, because the three ways a name falls outside call for three different
 * fixes: a hidden object is not the person's to use, an unqualified name needs its
 * container, a wildcard needs spelling out.
 *
 * The scanner errs toward refusal (its own header says why), and so does this: a
 * statement it cannot read is refused with the keyword that made it unreadable. Engines
 * whose query language is not SQL (a MongoDB command, a Redis command) are not judged
 * here at all - the rules filter what they show and nothing more, which the admin form
 * says in as many words.
 */
import type { DatabaseType } from "@/lib/types";
import { resolveSqlGrammar, readsSqlText } from "@/lib/sql/grammar";
import { referencedObjects } from "@/lib/sql/referenced-objects";
import { hasQualifiedPattern, type ObjectScope, referenceLabel, referenceVerdict } from "./rules";

export interface ObjectGateInput {
  readonly scope: ObjectScope;
  readonly statements: readonly string[];
  readonly type: DatabaseType;
  /** The datasource's name, for the sentence. */
  readonly datasourceName: string;
  /** How many container segments the provider declares above an object. */
  readonly depth: number;
  /** The session's default container, read only when an unqualified name needs placing. */
  readonly defaultContainer: () => Promise<readonly string[] | undefined>;
}

/** The refusal, or null when every statement stays inside the scope. */
export async function objectRefusal(input: ObjectGateInput): Promise<string | null> {
  const { scope, type, datasourceName, depth } = input;
  if (!scope.restricted || !readsSqlText(type)) return null;
  const grammar = resolveSqlGrammar(type);
  let defaultContainer: readonly string[] | undefined;
  let defaultContainerRead = false;

  for (const sql of input.statements) {
    const found = referencedObjects(sql, grammar);
    if (found.opaque !== undefined) {
      return (
        `"${datasourceName}" limits which objects you may use, and a ${found.opaque} statement cannot be ` +
        `checked for the objects it reaches. Write it as a statement that names its tables, or ask an administrator.`
      );
    }
    for (const reference of found.references) {
      // The default container is an engine round trip; read once, and only when a name
      // needs it - an unqualified name judged by a qualified pattern.
      if (
        !defaultContainerRead &&
        reference.qualifier.length === 0 &&
        depth > 0 &&
        !reference.wildcard &&
        hasQualifiedPattern(scope)
      ) {
        defaultContainer = await input.defaultContainer();
        defaultContainerRead = true;
      }
      const verdict = referenceVerdict(scope, reference, defaultContainer, depth);
      if (verdict === null) continue;
      const label = referenceLabel(reference);
      if (verdict === "wildcard") {
        return `"${label}" names objects by pattern; on "${datasourceName}" name each object you mean, so each can be checked.`;
      }
      if (verdict === "unqualified") {
        return (
          `Qualify "${label}" with its schema: "${datasourceName}" limits objects by schema and the session's ` +
          `default schema is not known here.`
        );
      }
      return `"${label}" is not an object you may use on "${datasourceName}".`;
    }
  }
  return null;
}
