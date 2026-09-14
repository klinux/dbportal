import { NextResponse } from "next/server";
import { canReview, decideApproval, getApproval } from "@/lib/approvals/store";
import { ApprovalError } from "@/lib/approvals/errors";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { settleDecision } from "@/lib/executions/store";
import { logger } from "@/lib/logger";
import { APPROVE_ACTION, REJECT_ACTION, SLACK_REVIEWER_PREFIX, respondToInteraction } from "@/lib/notify/slack";
import { verifySlackSignature } from "@/lib/notify/slack-signature";
import { withNamedRoles } from "@/lib/roles/store";

/**
 * A button pressed on the approval announcement (docs/CONTEXT.md §4.24). Slack posts the
 * interaction here, signed; the signature is the credential - there is no session and no
 * Origin - so it is verified first, on the raw body, and a request that fails it is a 401
 * audited like any refused credential. The person who pressed is the reviewer, named
 * `slack:<user id>`; whether they MAY review is the datasource's own rule (`approverRoles`,
 * through a named role whose members include `user:slack:<id>`), and nobody decides a
 * request made for them. The decision is the same `decideApproval` the page uses, so the
 * audit line and the four-eyes rule are the same; the announcement is then rewritten
 * without its buttons.
 */
interface Interaction {
  type?: string;
  user?: { id?: string; username?: string; name?: string };
  actions?: { action_id?: string; value?: string }[];
  response_url?: string;
}

function refused(route: string, request: Request) {
  const ip = clientAddress(request);
  const notice = consumeRateLimit("anon", ip);
  if (notice.allowed || notice.tripped) {
    try {
      emitAuditEvent({
        type: "permission_denied",
        action: "denied",
        target: route,
        user: "anonymous",
        result: "failure",
        reason: "invalid_signature",
        ip,
      });
    } catch (auditError) {
      logger.error("Failed to record permission_denied audit event", auditError, { route });
    }
  }
  // The words every credential-gated route answers with; the reason is on the audit line.
  return NextResponse.json({ error: "Authentication required" }, { status: 401 });
}

export async function POST(request: Request) {
  const route = "POST /api/slack/interactions";
  try {
    const body = await request.text();
    const secret = process.env.SLACK_SIGNING_SECRET ?? "";
    const verified = verifySlackSignature({
      body,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      secret,
    });
    if (!verified) return refused(route, request);

    const payload = new URLSearchParams(body).get("payload");
    let interaction: Interaction;
    try {
      interaction = JSON.parse(payload ?? "") as Interaction;
    } catch {
      return NextResponse.json({ error: "payload must be JSON" }, { status: 400 });
    }
    const action = interaction.actions?.[0];
    const slackUser = interaction.user?.id;
    const responseUrl = interaction.response_url ?? "";
    const tell = (text: string, decided = false) =>
      responseUrl
        ? respondToInteraction(
            responseUrl,
            decided ? { text, replace_original: true } : { text, response_type: "ephemeral" },
          )
        : Promise.resolve(false);
    if (
      interaction.type !== "block_actions" ||
      !slackUser ||
      !action ||
      (action.action_id !== APPROVE_ACTION && action.action_id !== REJECT_ACTION) ||
      typeof action.value !== "string"
    ) {
      // Anything but the two buttons is acknowledged and ignored, as Slack asks.
      return NextResponse.json({});
    }

    const reviewer = `${SLACK_REVIEWER_PREFIX}${slackUser}`;
    const record = await getApproval(action.value);
    if (!record || record.status !== "pending") {
      void tell(record ? `This request is already ${record.status}.` : "This request no longer exists.");
      return NextResponse.json({});
    }
    if (record.subject === slackUser) {
      void tell("You cannot review a request made for you.");
      return NextResponse.json({});
    }
    const session = await withNamedRoles({ role: "user" as const, username: reviewer });
    if (!(await canReview(record, session))) {
      void tell(
        `You are not a reviewer of "${record.datasourceName}". Ask an administrator to add slack:${slackUser} to a reviewer role.`,
      );
      return NextResponse.json({});
    }
    const decision = action.action_id === APPROVE_ACTION ? "approve" : "reject";
    const decided = await decideApproval({ id: record.id, reviewer, decision });
    const settled = await settleDecision(decided);
    const who = interaction.user?.username ?? interaction.user?.name ?? slackUser;
    if (settled.status === "pending") {
      // The first of two approvals (§4.28): recorded, the buttons stay for the second reviewer.
      void tell(
        `Recorded: ${settled.approvals?.length ?? 1} of ${settled.approvalsRequired ?? 2} approvals. A second reviewer must approve.`,
      );
      return NextResponse.json({});
    }
    void tell(
      `*${settled.status === "approved" ? "Approved" : "Rejected"}* by @${who} on *${record.datasourceName}*: \`${record.statement.slice(0, 200)}\``,
      true,
    );
    return NextResponse.json({});
  } catch (error) {
    if (error instanceof ApprovalError) {
      logger.warn("Slack decision refused", { route, statusCode: error.statusCode });
      return NextResponse.json({ error: error.message, statusCode: error.statusCode }, { status: error.statusCode });
    }
    return createErrorResponse(error, { route });
  }
}
