# Chat with the assistant in Slack

Message the Azhi Flow app in Slack, or mention it in a channel, and the [assistant](assistant.md) answers in a
thread. It can read what you are allowed to read (runs, workflows, approvals, usage) and propose actions. An
action runs only after you press Confirm.

This builds on [running workflows from Slack](slack-runs.md): the same bot token, signing secret and
Slack-user-to-Azhi-user link. `@azhi run <workflow>` still starts a run there; any other mention is a chat message.

Slack can reach the server in two ways. Pick one:

- **Request URLs over a public address** (see "Set up"): Slack calls the server's `/v1/slack/...` routes.
- **Socket Mode** (see "No public URL: Socket Mode"): the server connects out to Slack, so no public URL is needed.
  Use this for local runs.

## Set up

1. Secrets: `slack-bot-token` and `slack-signing-secret` (the app's signing secret), as for
   [approvals in Slack](slack-runs.md).
2. In the Slack app, add these bot token scopes: `app_mentions:read`, `chat:write`, `im:history`.
3. In the Slack app, turn on **Event Subscriptions** with the request URL `<public url>/v1/slack/events`, and
   subscribe to the bot events `app_mention` and `message.im`.
4. In the Slack app, turn on **Interactivity** with the request URL `<public url>/v1/slack/interactions`. The
   Confirm and Dismiss buttons on the assistant's cards are sent there.
5. In the Slack app, turn on **App Home**, then the **Messages** tab, so people can DM the app.
6. Link each person's Slack user to their Azhi Flow user on the Users page.
7. As an admin, under **System, Slack, Chat with the assistant in Slack**, turn on **Allow chat with the assistant
   from Slack**.

Event Subscriptions sends a signed check that the server must answer, so turn the setting on only after both
secrets are set.

## No public URL: Socket Mode

Instead of the request URLs above, Slack can connect out to the server over a websocket, so no tunnel or public
URL is needed (handy when running locally). The webhook and Socket Mode are alternatives; either one works.

1. In the Slack app, turn on **Socket Mode**, and create an **App-Level Token** with the scope
   `connections:write` (it starts with `xapp-`).
2. Store it: `npm run azhi -- secret set slack-app-token` (reads the value from stdin).
3. Keep **Event Subscriptions** on with the bot events `app_mention` and `message.im`, and **Interactivity** on.
   No request URL is needed for either, nor for the `/azhi` command.
4. Reinstall the app to the workspace.
5. Start the server (`npx azhi server start`, or `npm run azhi -- server start` from a checkout) and look for the
   log line `slack socket: connected (workspace <id>)`.

The secrets for this mode are `slack-bot-token`, `slack-signing-secret` and `slack-app-token`. The app-level token
only authenticates the connection. `slack-signing-secret` is still required: the server uses it internally to check
every event the same way as for the webhook. The server must run the `api` role (the default). It looks for enabled
workspaces and their secrets every 30 seconds, so turning the setting on or setting the token later normally needs
no restart; the connection line appears within that interval. A workspace without `slack-app-token` is skipped.

## Where you can talk to it

- **Direct message:** message the app. A new top-level message starts a new conversation. To continue it, reply in
  that thread; no mention is needed in a direct message.
- **A channel:** mention the app, for example `@azhi what failed today?`. The app must have been invited to the
  channel. The mention opens a thread under that message. To continue, reply in that thread and mention the app
  again.

Each conversation is a Slack thread. Replies in a channel thread without a mention are not read.

`@azhi run <workflow> key=value` still starts a workflow, exactly as in [running workflows from Slack](slack-runs.md).
Any other mention text is a chat message.

## Which model answers

By default the assistant uses the workspace's default model provider and model, as the web chat does. An admin can
pick another under **System, Slack, Chat with the assistant in Slack**, **Model**: choose a provider and one of its
models, or **Workspace default** to clear the choice. The choice applies to every Slack conversation and takes effect
from the next message. The setting is stored as `provider` and `model` next to `enabled` (`GET` and `PUT
/v1/settings/slack-assistant`); a provider without a model means that provider's default model.

If the chosen provider is not ready (for example its secret was removed), the assistant does not fall back to the
workspace default. The person gets "Sorry, I could not answer that: ..." in the thread, with a note that the default
model set under System, Slack may need attention, and the failure is audited as `assistant.slack_failed`. Each
`assistant.turn` records the provider and model that answered.

## Threads and ownership

- The person who starts a thread owns it. The assistant answers them with their own Azhi Flow user and role, so it
  shows only what they may see.
- Another person who writes in the same thread is refused with a short note, and should start their own thread.
- A Slack user who is not linked to an Azhi Flow user is refused, and told that an admin can link it on the Users
  page.
- If a message arrives while the last one is still being answered, the assistant says it is still working on it.

## Actions and confirmation

The assistant can propose to start a run, cancel a run, approve or reject an approval, and pause or resume a
schedule. It never runs these itself. It posts a card with the title and details, and two buttons:

- **Confirm** runs the action, once, with the arguments that were on the card.
- **Dismiss** cancels it; nothing runs.

Only the person who owns the thread can press either button; anyone else is told so, privately. Cancelling a run,
rejecting an approval and pausing a schedule also show a Slack "Are you sure?" dialog before Confirm runs. A second
press on a card that is already decided is answered only to the person who pressed, and nothing runs. The outcome
replaces the card, and the result or the failure is added to the conversation, so the next answer knows what
happened. A refusal, such as a press by someone who is not the owner, is not added to the conversation.

The same checks as in the web chat apply: the action is checked again on confirm, and each one is recorded in the
audit log as `assistant.action` with `via: slack`. Each turn is recorded as `assistant.turn`.

## If nothing happens

- Event Subscriptions must list the bot events `app_mention` and `message.im`, even in Socket Mode. Socket Mode only
  changes how events arrive, not which ones Slack sends.
- The toggle must be on: System, Slack, Chat with the assistant in Slack. If it is off, a mention or direct message gets
  a short reply saying so.
- `slack-bot-token` must be set. Without it the assistant cannot post, and the log says
  `slack assistant: the secret 'slack-bot-token' is not set`.
- Watch the server log. A line `slack socket: events_api app_mention -> 200` (Socket Mode) means the event arrived and
  was handled. No such line means Slack did not send it: check the subscriptions and that the app is in the channel.
  A status other than 200 (for example 401) means the signing secret does not match. Lines starting `slack events:`
  say why an event was not handled, and `slack assistant:` lines report a missing bot token or a failed reply. None
  of them contain message text.
- In Socket Mode, if `slack socket: connected` never appears, check that Socket Mode is on, that `slack-app-token` is
  set for this workspace, and that the toggle is on. Lines starting `slack socket: connection failed` give the reason.
- Your Slack user must be linked to an Azhi Flow user on the Users page, or the reply says it is not linked.
- The app must be in the channel (`/invite @azhi`) for mentions there. Direct messages need no invite.

## Limits

- Slack's reply deadline is short, so an answer first appears as "Thinking…" and is then replaced with the reply.
- A conversation keeps its recent messages. The oldest turns are dropped when it grows past the limit, so very
  long threads lose their early context.
- The assistant is asked to keep Slack answers short and to link to mission control for detail. This is a request to
  the model, not a hard limit.
- The assistant uses the workspace's default model provider, as in the web chat, unless an admin chose another (see
  "Which model answers"). If none is ready, it cannot answer.
- Message text is untrusted data. The assistant treats it as the person's own words, and a proposal still runs only
  after Confirm from the thread's owner.

## Not included

Streaming answers, file uploads, the workflow builder (it opens a browser page, so the assistant points to mission
control instead), and messages in channels that do not mention the app.
