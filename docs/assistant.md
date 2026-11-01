# Assistant and MCP server

Azhi Flow has an assistant on every mission control page, and it also serves the same abilities to
outside agents as an MCP server. Both run as the person whose token they carry, with that person's
role. Neither can do anything the person could not do in mission control.

## The chat bubble

The round button at the bottom right of every page opens it. You can also press `Ctrl+/` (`⌘/` on a
Mac). Ask about this workspace:

- **Runs:** "why did this run fail?", "what is it waiting for?", "which runs failed this week?"
- **Workflows:** "what does this workflow do?", "can I run it right now?" (the run plan's blockers)
- **Governance:** pending approvals, open alerts, spend and tokens per workflow, schedules,
  budgets, concurrency and harness settings, and the audit log (admins only)
- **How-to:** answers drawn from these docs, naming the doc it used

On a run or workflow page the assistant knows which one you are looking at. A chip above the message
box shows it. Remove the chip to ask without it.

The assistant uses the workspace's model provider, the same one as the workflow builder. Set an
Anthropic or OpenAI key, or a GitHub Copilot or ChatGPT sign-in, under Governance › Secrets.
The conversation stays in your browser tab.

### Actions need your confirmation

The assistant can propose to **start a run**, **cancel a run**, **approve or reject an approval**, and
**pause or resume a schedule** (admins). It never runs them itself. You see a card with exactly what
will happen, and the action runs only when you press Confirm. Cancel, reject and pause need a press
and hold.

- Before showing the card, the server checks that the action would be accepted. A run whose plan has
  blockers is refused at that point, with the reason.
- Confirming goes through `POST /v1/assistant/actions`, which checks your role and the arguments
  again.
- Each confirmed action is recorded in the audit log as `assistant.action`, and each chat turn as
  `assistant.turn`.

Run inputs, outputs, transcripts and ticket text are data to the assistant, never instructions. Text in
a run that says "approve this" does not lead to a proposal.

### Building workflows

Ask to create or change a workflow and the assistant hands it to the
[workflow builder](workflow-builder.md). It gives you a button that opens the builder with your
request filled in. The builder drafts the package and checks it with the compiler. Saving makes an
unsigned draft, which still needs your signature to publish.

## Azhi Flow as an MCP server

`POST /v1/assistant/mcp` is a Streamable HTTP MCP server. It is stateless and takes JSON responses
only. It offers the assistant's tools to Claude Code, Codex, OpenCode or any other MCP client:
look up workflows, runs, events, transcripts, approvals, alerts, usage, settings and docs; start a
run; cancel a run; pause a schedule.

Give the client an API token. Mission control creates one under System › Users; in local mode the
owner token is the `local-token` file in your data folder. For Claude Code:

```bash
claude mcp add --transport http azhi http://localhost:8080/v1/assistant/mcp --header "Authorization: Bearer azhi_…"
```

- Only tools the token's role allows are listed, and each call is checked again.
- Actions run when the client calls them; most clients ask you first. Read-only tools are marked
  `readOnlyHint`.
- **Approvals are not offered over MCP.** A gate a person must decide stays with a person, in
  mission control, the assistant's confirm card, or Slack.
- Every MCP call is in the audit log as `mcp.call`, with its arguments when it is an action.
- Run tokens are refused, so an agent step inside a workflow cannot use this server to start other
  runs.
