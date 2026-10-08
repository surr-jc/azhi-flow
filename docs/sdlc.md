# Feature delivery (SDLC) from a Jira ticket or a GitHub issue

`examples/sdlc` takes one ticket from intake to release and retro. A run starts from a **Jira
ticket**, read through a Jira MCP server, or a **GitHub issue**, read with the GitHub API. The
intake step turns either into one plain ticket, and the rest of the workflow reads only that.

Its agents plan and review but have no tools and no checkout, and its CI result is fixture data, so
a run never changes code. To have a run implement the ticket, test it and open a pull request, use
[`examples/sdlc-implement`](sdlc-implement.md).

```
source ─┬─ jira_issue (Jira MCP) ──┐
        └─ github_issue (GitHub) ──┴─ intake ─ requirements ─ design ─ design_review ─ build ─ ...
```

Run inputs: `source` (`jira` or `github`) and `ticket` (a Jira key such as `PAY-142`, or a GitHub
issue such as `acme/payments#42`, its URL, or `#42` when one repository is configured).

| Node | What it does |
|---|---|
| `source` | Condition on `inputs.source`: runs `jira_issue` or `github_issue`; the other is skipped |
| `jira_issue` | `jira.get-issue@1`: the `jira_get_issue` tool of a Jira MCP server ([mcp-atlassian](https://github.com/sooperset/mcp-atlassian), started with `uvx mcp-atlassian`, `READ_ONLY_MODE=true`, only `jira_get_issue` enabled) |
| `github_issue` | `github.get-issue@1` (builtin `github.issue`): title, body, labels, author and the first 20 comments; only repositories named at install; pull requests are refused |
| `intake` | `ticket.normalize@1` (builtin, no network): `{source, key, title, description, priority, reporter, status, labels, url}` from either shape. `merge: any` lets it run after whichever source ran |
| `requirements` ... `retro` | Unchanged agents, gates and notifications; messages name the ticket by `nodes.intake.output.key` |

## Set up (no file editing)

Examples page (**Examples**, card "Feature delivery (SDLC)"), or the CLI:

```bash
npx azhi example install sdlc --repo OWNER/REPO \
  --set slack_channel=C0123ABCD \
  --set jira_url=https://your-company.atlassian.net \
  --set jira_username=you@example.com
npx azhi secret set jira-api-token --value <Atlassian API token>       # for source=jira
npx azhi secret set github-read-token --value <read-only Issues token>  # for source=github
```

Settings are values the example install fills in wherever `{{name}}` appears in the example's
tools or in its workflow's `config:` block. Installing again without a setting keeps the value an
earlier install filled in. Only the secret for the source you use has to be set. `jira_issue`
needs [uv](https://docs.astral.sh/uv/) on the machine the server runs on (`uvx` downloads
mcp-atlassian on the first call).

## Untrusted ticket text

Anyone who can edit the ticket wrote its text, so it is handled like the PR text in the PR review
example:

- `ticket.normalize` removes control, zero-width and bidirectional characters, keeps the title on
  one line (200 characters) and caps the description (20,000 characters, comments included).
- Tool output is untrusted, so every agent downstream is tainted: the profiles tell the models the
  ticket is data, and the Slack posts carry a CEL guard that only allows the configured channel.
- Ticket text never becomes a command argument, a shell string or a tool name. The Jira key is
  checked against `^[A-Z][A-Z0-9_]*-[0-9]+$` before the MCP server sees it, and the GitHub
  reference is parsed and checked against the configured repositories.
- The MCP server gets `PATH`, the MCP SDK's default variables (`HOME`, `USER`, `SHELL`, `TERM`,
  `LOGNAME`), the settings and the token as `JIRA_API_TOKEN` (`credential_env` on the
  `mcp-stdio` transport). Nothing else from the server's environment.

## Other Jira setups

- Jira Server or Data Center: register `jira.get-issue@1` again with `credential_env:
  JIRA_PERSONAL_TOKEN` and no `JIRA_USERNAME` (mcp-atlassian's personal access token mode).
- Another stdio Jira MCP server: change `command` and `tool`. The normalizer reads mcp-atlassian's
  flattened issue and the Jira REST shape (`fields`, rich-text descriptions), as an object or as
  JSON text.
- Atlassian's hosted (remote) MCP server is not supported yet: Azhi's MCP tools are stdio only.

## Tests

`test/ticket-intake.test.ts` (no server) and `test/sdlc.test.ts` (end to end, scripted agents):
a fake Jira MCP server (`test/fixtures/sdlc/fake-jira-mcp.mjs`) and a fake GitHub. They check
both sources, the skipped branch, the normalized ticket, the hidden-character stripping, the
environment the MCP server gets, a missing ticket failing the run, and the install from the API,
the CLI (`--set`) and the Examples page.
