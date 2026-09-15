import { describe, test, expect, mock } from "bun:test";

/** The handlers this image registers at boot (docs/CONTEXT.md §4.40): `ping` answers with the time and the echo. */
const handlers = new Map<string, (job: unknown) => Promise<unknown>>();
mock.module("@/lib/jobs/worker", () => ({
  registerJobHandler: (k: string, h: (job: unknown) => Promise<unknown>) => handlers.set(k, h),
}));
const { registerJobHandlers } = await import("@/lib/jobs/handlers");

describe("job handlers", () => {
  test("ping", async () => {
    registerJobHandlers();
    expect([...handlers.keys()]).toEqual(["ping"]);
    const result = (await handlers.get("ping")!({ payload: { echo: "hi" } })) as { pong: string; echo: unknown };
    expect(Number.isNaN(Date.parse(result.pong))).toBe(false);
    expect(result.echo).toBe("hi");
    expect(((await handlers.get("ping")!({ payload: {} })) as { echo: unknown }).echo).toBeNull();
  });
});
