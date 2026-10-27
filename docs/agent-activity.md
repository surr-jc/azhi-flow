# Agent activity

The run page's **Agent activity** tab shows what each agent step is doing while it runs and keeps
it afterwards: the system prompt, the prompts it was given, the model's replies and reasoning, and
every tool call with its input and result (or error), plus each model call's token counts. It opens
first on runs that have agent steps; the Steps list on the canvas links to it ("Watch the agent
live").

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
