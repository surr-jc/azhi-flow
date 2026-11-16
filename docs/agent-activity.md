# Agent activity

The run page's **Activity log** tab shows everything a run does in one list, newest first, on a time
rail (offset from the run's start and clock time). Each step is one group holding its events
(started, finished, failed, approval requested and decided) and, for agent steps, what the agent
did: the system prompt, the prompts it was given, the model's replies and reasoning, every tool call
with its input and result (or error), and each model call's token counts. Run-wide events (started,
waiting, resumed) sit between the groups in time order.

Every group and line starts collapsed. A group's header shows its type, state, duration, event and
tool-call counts and any problems; opened, it shows the step's attempts, models, tokens and cost
("unavailable" when the run did not report them) and its lines. A line opens to its full detail.
Filters (Messages, Tools, Approvals, Problems), search, and Expand steps / Collapse all sit above
the list. The Steps list on the canvas links to a step's group ("Watch the agent live").

## Where it comes from

| Executor | How entries are captured |
| --- | --- |
| `opencode` | The worker follows OpenCode's event stream (`message.updated`, `message.part.updated`) for the step's session, so text and tool calls appear as they stream; at the end the session's stored messages fill anything the stream missed. |
| `claude-agent-sdk` | The SDK's assistant messages (text, thinking, tool_use) and the tool results in its user messages. |
| `codex` | `codex exec --json` items: agent messages, reasoning, MCP tool calls, commands. |
| model agent | The server records each turn: model text, tool calls and the results sent back, repairs. |

Workers send entries to `POST /v1/gateway/transcript` with the step's run token (so a step can only
write its own node), batched every 0.7 s. The page reads `GET /v1/runs/:id/transcript?after=<cursor>`
every second while the run is open; an entry that changes (a tool call going from running to done)
comes back with a new version.

## Secrets

Entries are redacted twice: on the worker, with the step's own secrets (provider key or Copilot
sign-in, run token, OpenCode server password, workspace git token), and on the server, with the
values of every credential the run token may read. Both also blank token-shaped strings (provider
keys, GitHub, Slack and AWS tokens, bearer headers, private keys) and fields named like `api_key`,
`token` or `password` in tool inputs. Each text field is kept up to 32 KB (long tool results keep
their start and end), and a step attempt keeps up to 2,000 entries.

Set `AZHI_AGENT_TRANSCRIPTS=0` on the server to stop storing transcripts.
