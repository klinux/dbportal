import { describe, test, expect, mock, afterEach } from "bun:test";
import { emitAuditEvent, setAuditObserver } from "@/lib/audit";

/** The observer hook on the audit channel (docs/CONTEXT.md §4.32): called with the stored event, fire-and-forget, and its failure never reaches the emitter. */
describe("audit observer", () => {
  afterEach(() => setAuditObserver(null));

  test("sees each stored event; a rejection is swallowed", async () => {
    const seen: string[] = [];
    setAuditObserver(async (event) => {
      seen.push(event.id);
      if (event.action === "boom") throw new Error("observer down");
    });
    const first = emitAuditEvent({ type: "alert", action: "saved", target: "x", user: "ana", result: "success" });
    const second = emitAuditEvent({ type: "alert", action: "boom", target: "x", user: "ana", result: "success" });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([first.id, second.id]);
    expect(mock(() => {})).toBeDefined();
  });
});
