/**
 * A refusal of the masking layer (docs/CONTEXT.md §4.7): a reveal the session may not make
 * (403), a configuration that does not validate (400), or no store to save it in (503).
 * Its own module so the shared error mapper can answer it without importing the store.
 */
export class MaskingError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MaskingError";
  }
}
