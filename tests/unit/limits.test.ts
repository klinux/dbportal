import { describe, test, expect, beforeEach } from "bun:test";
import {
  ConcurrencyLimitError,
  capPrepareOptions,
  effectiveTimeout,
  resetConcurrency,
  runningCount,
  withConcurrency,
} from "@/lib/limits";

/**
 * Limits per datasource (docs/CONTEXT.md §4.16): the row cap a client cannot exceed, the
 * timeout the datasource decides, and the per-person concurrency gate that refuses the
 * statement over the limit rather than queueing it.
 */
describe("capPrepareOptions", () => {
  test("without a cap the options pass through; with one, fewer is kept, more is cut, unlimited becomes the cap", () => {
    expect(capPrepareOptions({ limit: 50 }, undefined)).toEqual({ limit: 50 });
    expect(capPrepareOptions({ limit: 50 }, { maxRows: 200 })).toEqual({ limit: 50, unlimited: false });
    expect(capPrepareOptions({ limit: 5000 }, { maxRows: 200 })).toEqual({ limit: 200, unlimited: false });
    expect(capPrepareOptions({ unlimited: true }, { maxRows: 200 })).toEqual({ limit: 200, unlimited: false });
    expect(capPrepareOptions({}, { maxRows: 200 })).toEqual({ limit: 200, unlimited: false });
    expect(capPrepareOptions({ limit: 0 }, { maxRows: 200 })).toEqual({ limit: 1, unlimited: false });
    expect(capPrepareOptions({ limit: 10, offset: 20 }, { maxRows: 200 })).toEqual({
      limit: 10,
      offset: 20,
      unlimited: false,
    });
  });
});

describe("effectiveTimeout", () => {
  test("the datasource's timeout wins; without one the connection's own stays", () => {
    expect(effectiveTimeout({ queryTimeoutMs: 5000 }, 60000)).toBe(5000);
    expect(effectiveTimeout({}, 60000)).toBe(60000);
    expect(effectiveTimeout(undefined, undefined)).toBeUndefined();
  });
});

describe("withConcurrency", () => {
  beforeEach(() => {
    resetConcurrency();
  });

  const ds = { id: "orders", name: "Orders", limits: { maxConcurrent: 2 } };
  const gate = () => {
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release, work: () => done.then(() => "ok") };
  };

  test("counts a person's running statements on a datasource and refuses the one over the limit with a 429", async () => {
    const a = gate();
    const b = gate();
    const first = withConcurrency(ds, "ana", a.work);
    const second = withConcurrency(ds, "ana", b.work);
    expect(runningCount("orders", "ana")).toBe(2);
    const third = await withConcurrency(ds, "ana", async () => "never").catch((e) => e);
    expect(third).toBeInstanceOf(ConcurrencyLimitError);
    expect(third.statusCode).toBe(429);
    expect(third.message).toBe('"Orders" allows 2 running statements per person; wait for or cancel one of yours');
    // Another person, and another datasource, are counted apart.
    expect(await withConcurrency(ds, "bob", async () => "bob")).toBe("bob");
    expect(await withConcurrency({ ...ds, id: "other" }, "ana", async () => "other")).toBe("other");
    a.release();
    b.release();
    expect(await first).toBe("ok");
    expect(await second).toBe("ok");
    expect(runningCount("orders", "ana")).toBe(0);
  });

  test("a statement that throws still releases its slot; a limit of one reads in the singular", async () => {
    const one = { id: "x", name: "X", limits: { maxConcurrent: 1 } };
    await expect(
      withConcurrency(one, "ana", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(runningCount("x", "ana")).toBe(0);
    const g = gate();
    const held = withConcurrency(one, "ana", g.work);
    const refused = await withConcurrency(one, "ana", async () => 1).catch((e) => e);
    expect(refused.message).toContain("allows 1 running statement per person");
    g.release();
    await held;
  });

  test("without a limit nothing is counted", async () => {
    expect(await withConcurrency({ id: "free", name: "Free" }, "ana", async () => 7)).toBe(7);
    expect(runningCount("free", "ana")).toBe(0);
  });
});
