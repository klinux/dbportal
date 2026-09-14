import { logger } from "@/lib/logger";
import type { ApprovalRequest } from "@/lib/storage/types";

/**
 * The Slack notifier (docs/CONTEXT.md §4.10): two messages, both best effort. A pending
 * execution request is announced to the reviewers' channel with a link to the approvals
 * page; a finished one is answered in the thread the request named. Nothing here throws to
 * a caller: a Slack outage must not fail a request that was queued or ran correctly, so a
 * failure is one warning line. Off entirely without SLACK_BOT_TOKEN.
 *
 * What a thread gets: the outcome, who approved, and a bounded preview of the rows, which
 * left the server already masked. The full result is behind the portal's own login.
 */
const POST_MESSAGE = "https://slack.com/api/chat.postMessage";
export const PREVIEW_ROWS = 10;
const CELL_MAX = 40;

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

/** Buttons are offered only when the interactivity endpoint can verify the click (§4.24). */
export function slackInteractive(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET);
}

/** How a Slack user is named as a reviewer: `slack:<user id>`, the id being stable where the handle is not. */
export const SLACK_REVIEWER_PREFIX = "slack:";
export const APPROVE_ACTION = "approval_approve";
export const REJECT_ACTION = "approval_reject";

type Block = Record<string, unknown>;

/** The announcement's blocks: the text, and the two buttons that decide it from the channel. */
export function approvalBlocks(record: ApprovalRequest, text: string): Block[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: `approval:${record.id}`,
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION,
          value: record.id,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
        },
        {
          type: "button",
          action_id: REJECT_ACTION,
          value: record.id,
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
        },
      ],
    },
  ];
}

/**
 * The answer to a click, through the `response_url` Slack hands the endpoint: the message
 * rewritten without its buttons once decided, or a note only the clicker sees. Best effort.
 */
export async function respondToInteraction(
  responseUrl: string,
  body: { text: string; replace_original?: boolean; response_type?: "ephemeral" | "in_channel" },
): Promise<boolean> {
  if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) return false;
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!res.ok) logger.warn("Slack interaction response not delivered", { status: res.status });
    return res.ok;
  } catch (error) {
    logger.warn("Slack interaction response not delivered", { error: (error as Error).name });
    return false;
  }
}

function appUrl(path: string): string {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

async function post(body: { channel: string; text: string; thread_ts?: string; blocks?: Block[] }): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(POST_MESSAGE, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || reply.ok !== true) {
      // Slack's error code is a closed word ("channel_not_found"), safe to log; the text is not logged.
      logger.warn("Slack message not delivered", { channel: body.channel, status: res.status, error: reply.error });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn("Slack message not delivered", { channel: body.channel, error: (error as Error).name });
    return false;
  }
}

function cell(value: unknown): string {
  const text =
    value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
}

/** A fixed-width preview of the first rows: header, rule, rows; pipes rather than a Slack table. */
export function previewOf(fields: string[], rows: Record<string, unknown>[], truncated: boolean | undefined): string {
  if (fields.length === 0) return "";
  const shown = rows.slice(0, PREVIEW_ROWS);
  const width = fields.map((f) => Math.max(f.length, ...shown.map((r) => cell(r[f]).length), 1));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i])).join(" | ");
  const out = [
    line(fields),
    width.map((w) => "-".repeat(w)).join("-+-"),
    ...shown.map((r) => line(fields.map((f) => cell(r[f])))),
  ];
  const more = rows.length > shown.length || truncated ? "\n…" : "";
  return `\`\`\`\n${out.join("\n")}${more}\n\`\`\``;
}

/** What Slack shows of a statement: a message has room for a few thousand characters, not a script. */
export const STATEMENT_EXCERPT_CHARS = 2_500;

export function statementExcerpt(statement: string): string {
  if (statement.length <= STATEMENT_EXCERPT_CHARS) return statement;
  return `${statement.slice(0, STATEMENT_EXCERPT_CHARS)}\n… (${statement.length - STATEMENT_EXCERPT_CHARS} more characters; the whole statement is on the review page)`;
}

/** "X asked to run … on Y" to the reviewers' channel, with the page that decides. */
export async function notifyReviewers(record: ApprovalRequest): Promise<boolean> {
  const channel = process.env.SLACK_APPROVALS_CHANNEL;
  if (!channel || !slackConfigured()) return false;
  const who = record.subject ? `${record.subject} (via ${record.requester})` : record.requester;
  const text = [
    `*Execution waiting for approval* on *${record.datasourceName}*`,
    `Asked by ${who}.`,
    `\`\`\`\n${statementExcerpt(record.statement)}\n\`\`\``,
    `Review: ${appUrl("/admin/approvals")}`,
  ].join("\n");
  // With a signing secret the message carries the two buttons; without one, the link is the way.
  return post({ channel, text, ...(slackInteractive() ? { blocks: approvalBlocks(record, text) } : {}) });
}

/** The outcome, into the thread the request named. */
export async function notifyExecutionOutcome(record: ApprovalRequest): Promise<boolean> {
  if (!record.reply || !slackConfigured()) return false;
  const outcome = record.execution;
  let text: string;
  if (record.status === "rejected") {
    text = `*Rejected* by ${record.reviewer ?? "a reviewer"} on *${record.datasourceName}*.${record.note ? ` ${record.note}` : ""}`;
  } else if (!outcome) {
    return false;
  } else if (outcome.status === "failed") {
    text = `*Failed* on *${record.datasourceName}* (${outcome.error ?? "execution_failed"}). An administrator sees the detail in the audit log.`;
  } else {
    const rows = outcome.rowCount ?? outcome.rows?.length ?? 0;
    const head = `*Done* on *${record.datasourceName}*${record.reviewer ? `, approved by ${record.reviewer}` : ""}: ${rows} row${rows === 1 ? "" : "s"} in ${outcome.durationMs} ms.`;
    const preview = outcome.fields && outcome.rows ? previewOf(outcome.fields, outcome.rows, outcome.truncated) : "";
    text = preview ? `${head}\n${preview}` : head;
  }
  return post({
    channel: record.reply.channel,
    text,
    ...(record.reply.threadTs ? { thread_ts: record.reply.threadTs } : {}),
  });
}
