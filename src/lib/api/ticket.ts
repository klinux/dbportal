/**
 * The ticket or incident reference a request may carry (docs/CONTEXT.md §4.18): free text,
 * trimmed and bounded, so an audit line can be joined to the change that asked for it.
 * Anything that is not a short string is treated as absent - the gate decides whether
 * absent is allowed.
 */
export const TICKET_MAX_CHARS = 120;

export function readTicket(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, TICKET_MAX_CHARS);
  return text.length > 0 ? text : undefined;
}
