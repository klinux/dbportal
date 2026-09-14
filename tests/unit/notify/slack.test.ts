import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The Slack notifier (docs/CONTEXT.md §4.10): off without a token, best effort with one,
 * the announcement to reviewers with the page's link, the outcome into the thread with a
 * bounded preview, and never a throw to the caller. Slack is a spied fetch.
 */
const warn = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { warn, info: () => {}, error: () => {}, debug: () => {} },
}));
const { notifyExecutionOutcome, notifyReviewers, previewOf, slackConfigured, statementExcerpt, PREVIEW_ROWS } =
  await import("@/lib/notify/slack");

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const holder = globalThis as unknown as { fetch: FetchLike };
let fetchSpy: ReturnType<typeof spyOn<{ fetch: FetchLike }, "fetch">>;
const saved: Record<string, string | undefined> = {};

const base: ApprovalRequest = {
  id: "exec-1",
  kind: "execution",
  datasourceId: "orders",
  datasourceName: "Orders",
  requester: "svc:slack-bot",
  subject: "U0123",
  statement: "SELECT id FROM orders LIMIT 5",
  route: "POST /api/v1/executions",
  status: "pending",
  requestedAt: "2026-09-14T00:00:00.000Z",
  reply: { channel: "C0456", threadTs: "1726.0001" },
};

const sent = () => fetchSpy.mock.calls.map((c) => JSON.parse(((c as unknown[])[1] as RequestInit).body as string));

describe("slack notifier", () => {
  beforeEach(() => {
    for (const k of ["SLACK_BOT_TOKEN", "SLACK_APPROVALS_CHANNEL", "APP_URL"]) saved[k] = process.env[k];
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APPROVALS_CHANNEL = "C0REV";
    process.env.APP_URL = "https://portal.example.test/";
    fetchSpy = spyOn(holder, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    warn.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const k of ["SLACK_BOT_TOKEN", "SLACK_APPROVALS_CHANNEL", "APP_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("without a bot token nothing is sent and both notifications answer false", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(slackConfigured()).toBe(false);
    expect(await notifyReviewers(base)).toBe(false);
    expect(await notifyExecutionOutcome({ ...base, status: "rejected" })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // docs/CONTEXT.md §4.21: a script does not fit a Slack message; the excerpt says how much is left.
  test("a long statement is excerpted in the announcement, pointing at the review page for the rest", async () => {
    const long = `UPDATE orders SET status = 'x' WHERE id IN (${Array.from({ length: 3_000 }, (_, i) => i).join(", ")})`;
    expect(statementExcerpt("SELECT 1")).toBe("SELECT 1");
    const excerpt = statementExcerpt(long);
    expect(excerpt.startsWith(long.slice(0, 2_500))).toBe(true);
    expect(excerpt).toContain(`${long.length - 2_500} more characters`);
    expect(await notifyReviewers({ ...base, statement: long })).toBe(true);
    const [body] = sent();
    expect(body.text).not.toContain(long);
    expect(body.text).toContain("more characters");
  });

  test("announces a pending request to the reviewers' channel with the person, the statement and the page", async () => {
    expect(await notifyReviewers(base)).toBe(true);
    const [call] = fetchSpy.mock.calls as unknown[][];
    expect(String(call[0])).toBe("https://slack.com/api/chat.postMessage");
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer xoxb-test" });
    const [body] = sent();
    expect(body.channel).toBe("C0REV");
    expect(body.text).toContain("U0123 (via svc:slack-bot)");
    expect(body.text).toContain("SELECT id FROM orders LIMIT 5");
    expect(body.text).toContain("https://portal.example.test/admin/approvals");
    expect(body).not.toHaveProperty("thread_ts");
    // Without a reviewers' channel there is nowhere to announce.
    delete process.env.SLACK_APPROVALS_CHANNEL;
    expect(await notifyReviewers(base)).toBe(false);
  });

  test("a request without a subject names the requester alone, and the link is relative without APP_URL", async () => {
    delete process.env.APP_URL;
    const { subject, ...noSubject } = base;
    void subject;
    await notifyReviewers(noSubject);
    const [body] = sent();
    expect(body.text).toContain("Asked by svc:slack-bot.");
    expect(body.text).toContain("Review: /admin/approvals");
  });

  test("the outcome goes into the thread: done with a preview, failed with the closed reason, rejected with the note", async () => {
    const done: ApprovalRequest = {
      ...base,
      status: "approved",
      reviewer: "root",
      execution: {
        status: "done",
        startedAt: "x",
        finishedAt: "y",
        durationMs: 12,
        rowCount: 1,
        fields: ["id", "note"],
        rows: [{ id: 1, note: null }],
      },
    };
    expect(await notifyExecutionOutcome(done)).toBe(true);
    let [body] = sent();
    expect(body).toMatchObject({ channel: "C0456", thread_ts: "1726.0001" });
    expect(body.text).toContain("*Done* on *Orders*, approved by root: 1 row in 12 ms.");
    expect(body.text).toContain("id | note");

    fetchSpy.mockClear();
    await notifyExecutionOutcome({
      ...base,
      status: "approved",
      execution: { status: "failed", startedAt: "x", finishedAt: "y", durationMs: 3, error: "query_error" },
    });
    [body] = sent();
    expect(body.text).toContain("*Failed* on *Orders* (query_error)");

    fetchSpy.mockClear();
    await notifyExecutionOutcome({ ...base, status: "rejected", reviewer: "root", note: "Not on a Friday." });
    [body] = sent();
    expect(body.text).toBe("*Rejected* by root on *Orders*. Not on a Friday.");

    fetchSpy.mockClear();
    await notifyExecutionOutcome({ ...base, status: "rejected" });
    [body] = sent();
    expect(body.text).toBe("*Rejected* by a reviewer on *Orders*.");
  });

  test("no thread to answer, or an approval that has not run yet, sends nothing; a thread without ts posts to the channel", async () => {
    const { reply, ...noReply } = base;
    void reply;
    expect(await notifyExecutionOutcome({ ...noReply, status: "rejected" })).toBe(false);
    expect(await notifyExecutionOutcome({ ...base, status: "approved" })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    await notifyExecutionOutcome({
      ...base,
      reply: { channel: "C0456" },
      status: "approved",
      execution: { status: "done", startedAt: "x", finishedAt: "y", durationMs: 1, rowCount: 0, fields: [], rows: [] },
    });
    const [body] = sent();
    expect(body).not.toHaveProperty("thread_ts");
    expect(body.text).toBe("*Done* on *Orders*: 0 rows in 1 ms.");
  });

  test("a refusal from Slack and a network failure are one warning each, never a throw; the text is not logged", async () => {
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    );
    expect(await notifyReviewers(base)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("channel_not_found");
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("SELECT");
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await notifyReviewers(base)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    // A body that is not JSON is a refusal too.
    fetchSpy.mockImplementation(async () => new Response("<html>", { status: 502 }));
    expect(await notifyReviewers(base)).toBe(false);
  });

  test("previewOf pads columns, caps rows and cells, stringifies objects and empties nulls, and marks what was cut", () => {
    const rows = Array.from({ length: PREVIEW_ROWS + 2 }, (_, i) => ({
      id: i,
      meta: { a: i },
      long: "x".repeat(60),
      n: null,
    }));
    const text = previewOf(["id", "meta", "long", "n"], rows, false);
    const lines = text.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines[1].startsWith("id | meta")).toBe(true);
    expect(lines[2]).toMatch(/^-+-\+-/);
    expect(lines.length).toBe(PREVIEW_ROWS + 3 + 2);
    expect(text).toContain('{"a":0}');
    expect(text).toContain("…\n```");
    expect(text).not.toContain("x".repeat(41));
    expect(previewOf([], [], false)).toBe("");
    expect(previewOf(["id"], [{ id: 1 }], true)).toContain("…");
    expect(previewOf(["id"], [{ id: 1 }], false)).not.toContain("…");
  });
});
