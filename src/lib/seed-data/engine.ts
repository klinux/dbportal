/**
 * The engines a datasource can be seeded on (docs/CONTEXT.md §4.23): PostgreSQL, the first,
 * and MySQL. Pure, so the Operations page can decide what the Seed tab offers without the
 * server modules.
 */
export type SeedEngine = "postgres" | "mysql";

export const SEED_ENGINES: readonly SeedEngine[] = ["postgres", "mysql"];

export function seedEngineOf(type: string | undefined): SeedEngine | null {
  return (SEED_ENGINES as readonly string[]).includes(type ?? "") ? (type as SeedEngine) : null;
}

/** The engine's name as a person reads it. */
export function seedEngineLabel(engine: SeedEngine): string {
  return engine === "mysql" ? "MySQL" : "PostgreSQL";
}
