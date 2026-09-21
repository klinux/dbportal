# Integrating a chat bot with dbportal

A guide for the team that maintains a chat bot (Slack, or any program) that receives
requests to run statements on a database. It covers what to set up in the portal once,
what the bot sends, what it gets back, and what the bot stops doing because the portal does
it. The design behind each piece is in [CONTEXT.md](CONTEXT.md) §4.10 (the queue), §4.15
(guardrails), §4.24 (Slack buttons), §4.25 (signed callback), §4.56 (object rules) and
§4.57 (the bot's own hold); the request and response shapes are in
[API_DOCS.md](API_DOCS.md) under "Executions API".

## What moves from the bot to the portal

| The bot did | With the portal |
|---|---|
| Judged the statement and decided whether it may run | Sends everything; the portal decides: a read runs, a write on a datasource that requires approval, a guardrail, or a request the bot holds itself, waits |
| Asked the owners for approval | The portal announces the request to the reviewers' channel **and** into the request's thread, with Approve and Reject buttons |
| Ran the statement after approval | The portal runs the exact text that was approved, on the server, and posts the outcome into the thread |
| Called a person when something looked wrong | Sends the request with `review: { reason }`; it waits in the same queue, on the web page and in the thread |
| Held database credentials | None: the bot knows a `datasourceId` and a portal token |

The bot becomes transport: it receives the request in the chat, calls one endpoint, and
optionally tells the thread what happened.

## 1. Set up once, in the portal

1. **A service token.** Security → Service tokens: role `user`, the team's groups, the
   allowlist of datasources the bot may use, `requireApproval` off (the portal and the bot
   decide per request). The value `dbp_…` is shown once; it goes into the bot's secrets.
2. **Reviewers.** On each datasource, `approverRoles` naming a named role (Security → Roles)
   whose members include `user:slack:<user id>` for everyone who may press the buttons,
   beside the groups that decide on the web page. The person a request was made for cannot
   decide it. `approvalsRequired: 2` asks for two reviewers.
3. **The Slack app**, when the bot lives in Slack: `SLACK_BOT_TOKEN` (`chat:write`),
   `SLACK_APPROVALS_CHANNEL` (the channel the app was invited to) and, for the buttons,
   `SLACK_SIGNING_SECRET` with Interactivity pointing at
   `https://<portal>/api/slack/interactions`. See [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md).
4. **Datasource ids.** The ids on Admin → Datasources (for example `orders-prod`), or the
   MCP endpoint's `list_datasources` for the ones the token may open.

## 2. The request

```http
POST https://<portal>/api/v1/executions
Authorization: Bearer dbp_…
Content-Type: application/json
```

```json
{
  "datasourceId": "orders-prod",
  "statement": "UPDATE orders SET status = 'cancelled' WHERE id = 42",
  "onBehalfOf": "U0123",
  "reply": { "channel": "C0456", "threadTs": "1726.0001" },
  "ticket": "INC-1234",
  "review": { "reason": "update on a billing table" }
}
```

- `onBehalfOf` (required): the person who asked, as the chat identifies them. Written to
  the audit line as `subject`; that person cannot approve the request.
- `reply`: the channel and thread of the request. The announcement with its buttons and the
  outcome (ten rows at most) are posted there.
- `ticket`: optional; required by a datasource with `requireTicket`.
- `review`: optional. Use it where the bot's own analysis would have called a person: the
  request waits for a reviewer whatever the datasource's policy would have let run, and the
  reason is shown on the reviewers' page, in the announcement and in the record.
- `callback: { url }`: optional; the outcome is POSTed there, signed, instead of polled. The
  host must be in `CALLBACK_ALLOWED_HOSTS`.

## 3. The answers

| Status | Meaning | What the bot does |
|---|---|---|
| `200 { execution }` | Ran at once (a read, nothing to approve). `execution.execution` carries `rowCount`, `fields`, `rows` (bounded and masked) | Nothing required; the portal already posted the outcome into the thread |
| `202`, `execution.status: "pending"` | Waiting for a reviewer; `guardrail` or `review` says why | Nothing; the buttons are already in the thread. Optionally: "waiting for approval" |
| `202`, `execution.status: "approved"` with `jobId` | Approved, a worker is running it | Poll `GET /api/v1/executions/{id}` until `execution` is set |
| `400` | Invalid body: `review` without a reason, `onBehalfOf` missing, statement over 32 000 characters, a `callback` host not allowed | Show the message |
| `403` | The token may not use the datasource, a write on a read-only one, a ticket required, a freeze window, or an object the datasource's rules keep from the token | Show the portal's message in the thread; it says what to do |
| `404` | Unknown `datasourceId` | Show it |
| `429` | The datasource's concurrency limit | Retry later |

Polling:

```http
GET https://<portal>/api/v1/executions/{id}
Authorization: Bearer dbp_…
```

The record comes back; `status` becomes `approved` or `rejected`, and `execution.status`
becomes `done`, or `failed` with `error` as a closed word (`permission_denied`,
`freeze_window`, `execution_failed`, …). The portal posts the outcome into the thread on its
own; the bot reads it back only if it wants to act on it.

## 4. A handler, in outline

```python
def handle_request(user, channel, thread_ts, datasource, sql, reason=None, ticket=None):
    body = {
        "datasourceId": datasource,
        "statement": sql,
        "onBehalfOf": user,
        "reply": {"channel": channel, "threadTs": thread_ts},
    }
    if ticket:
        body["ticket"] = ticket
    if reason:  # where the bot used to call a person
        body["review"] = {"reason": reason}

    r = requests.post(f"{PORTAL}/api/v1/executions", json=body,
                      headers={"Authorization": f"Bearer {TOKEN}"}, timeout=30)
    data = r.json()

    if r.status_code == 200:
        return None  # the portal posted the result into the thread
    if r.status_code == 202:
        if data["execution"]["status"] == "pending":
            return "Waiting for approval; the buttons are in this thread."
        return f"Approved; running (id {data['execution']['id']})."
    return f"Refused by the portal: {data.get('error')}"
```

No database credential, no list of reviewers, no statement executed by the bot.

## 5. What to remove from the bot

- Direct execution against the database, and the credentials that made it possible.
- The "may it run" logic the portal already has: guardrails (`DELETE` or `UPDATE` without
  `WHERE`, `DROP`, `TRUNCATE`), read-only datasources, freeze windows, tickets, object
  rules and row limits. Keep only what the portal cannot know, and send it as
  `review.reason`.
- The approval flow: the buttons replace it, and who may decide is declared per datasource.

## 6. A test plan

1. `SELECT 1` on a datasource in the allowlist → `200`.
2. `UPDATE … WHERE id = 1` on a datasource with `writeApproval` → `202 pending`; the
   announcement in the thread and in the reviewers' channel; press Approve → the outcome in
   the thread.
3. `DELETE FROM t` without `WHERE` → `202 pending` with `guardrail`.
4. Any read with `review: { reason: "test" }` → `202 pending`; the "held by requester"
   badge on Admin → Approvals.
5. A datasource outside the allowlist → `403`.
6. `GET /api/v1/executions/{id}` on each → the record with its outcome.
