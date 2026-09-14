/** A refusal of the seed-data feature with the status it answers (docs/CONTEXT.md §4.23). */
export class SeedDataError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SeedDataError";
  }
}
