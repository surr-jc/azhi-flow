# Run workflows from Slack

Type `/azhi run <workflow> key=value ...` in Slack. Azhi Flow starts the workflow as you, then follows it in
one Slack thread: the run's approvals are asked there, and its final result is posted there once.

This builds on [approvals in Slack](mission-control-plan.md): the same bot token, signing secret and
Slack-user-to-Azhi-user link. To chat with the assistant in Slack instead of starting runs, see
[chat with the assistant in Slack](slack-assistant.md).

## Set up

1. Secrets: `slack-bot-token` (scope `chat:write`) and `slack-signing-secret` (the app's signing secret).
2. In the Slack app, add a slash command `/azhi` with the request URL shown under **System, Slack, Run workflows from
   Slack** in mission control (`<public url>/v1/slack/commands`).
   Without a public URL, use [Socket Mode](slack-assistant.md#no-public-url-socket-mode) instead of request URLs.
3. Link each person's Slack user to their Azhi Flow user on the Users page.
4. As an admin, turn on **Allow runs from Slack** and list the workflow slugs Slack may start. Nothing can be
   started until a slug is listed. Optionally set a channel ID for the threads; otherwise the thread is created in
   the channel where the command was typed (the bot must be a member).

### Tagging the app

Instead of (or as well as) the slash command, people can tag the app in a channel it has been invited to:

```
@azhi run quality-report
@azhi run pr-review repo=acme/api pr=123
```

Setup, in the Slack app: turn on **Event Subscriptions**, set the request URL to `<public url>/v1/slack/events`
(Slack sends a signed check that the server answers, so enable the setting and set both secrets first), subscribe
to the bot event `app_mention`, and add the scope `app_mentions:read`.

The checks and the result are the same as for the command, with two differences: the message you typed is the
thread root (so replies, approvals and the result appear under it), and a refusal is answered in that thread
because a mention has no private reply. Mentions by bots and resent events are ignored.

## What happens

| Step | Behaviour |
| --- | --- |
| Verify | The request must carry a valid Slack signature (5 minute window). Anything else is a 401. |
| Who | The Slack user must be linked to an enabled Azhi Flow user with the `operator` role or above. |
| What | The workflow slug must be on the allowlist. The newest **published** version runs, so a draft cannot be started from Slack. |
| Start | The run starts through the same path as `POST /v1/runs`: plan blockers, budgets and role checks all apply. |
| Thread | A message in the channel opens the thread. Approvals for this run are asked in it, with the usual buttons. |
| Result | When the run ends, one message with the state, the duration and a link to mission control. |

Refusals (unlinked user, low role, not allowed, usage errors, blockers) are private replies and start nothing.
Slack resends a command it thinks timed out; those retries are ignored so a run starts once.

## Inputs are data

Everything after the workflow slug is untrusted text. It only becomes string inputs: keys must look like
identifiers, at most 20 pairs, values at most 1000 characters, quoted values may contain spaces. The workflow is
chosen by exact slug, never by a version, path or tool name taken from the text.

## Reading the result

The result line shows the run state and duration. A duration or error that is not recorded reads
"unavailable"; nothing is guessed.

## Not included

Progress for individual steps, and `status` or `cancel` (as a command or a mention). Only `run` is understood.
