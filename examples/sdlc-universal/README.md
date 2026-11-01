# SDLC universal: Jira, GitHub and Confluence to a reviewed pull request

Give it a Jira ticket or a GitHub issue, and optionally one Confluence page. It checks the ticket is ready,
proves the repository's tests run on the base branch, plans, builds, has an independent reviewer and a
verifier challenge the change, and, after a person approves, pushes a branch and opens a pull request.
Nothing reaches GitHub without that approval, and the pull request says how much was verified.

It is derived from [AI-SDLC v2](../ai-sdlc-v2/README.md) and is the unattended counterpart of the
interactive Claude Code layer in `.claude/` ([.claude/README.md](../../.claude/README.md)). Both read the
same nine-field ticket.

## What is general, and what is not

| Part | Works with | Not covered |
|---|---|---|
| **Ticket** | Jira through the bundled `jira.get-issue@1` tool (mcp-atlassian), GitHub issues, one Confluence Cloud page | Jira Server/Data Center (see below), GitLab/Linear/other trackers |
| **Models** | Anthropic, GitHub Copilot, ChatGPT plan, through OpenCode; one model per role (tiers) or one model for all | Plain OpenAI API keys: the built-in model agent drives them but cannot open a checkout |
| **Harness** | `opencode` (every agent step needs a checkout, and only OpenCode can give one) | `claude-agent-sdk` and `codex` cannot run workspace steps; see "Other harnesses" |
| **Language / test stack** | Node (npm, pnpm, yarn), Rust, Go, Python by detection; anything else through `.azhi/commands.json` | A repository with no runnable tests: the run goes to the static path or is paused |
| **Code host** | GitHub (checkout, push, pull request) | GitLab, Bitbucket: the repository tools are GitHub-only |

## Set up

```bash
# 1. Pick the models (optional). Without this every step says `name: default`.
node examples/sdlc-universal/scripts/apply_models.mjs anthropic     # or github-copilot | openai-chatgpt | default

# 2. Install, naming the repository.
azhi example needs sdlc-universal
azhi example install sdlc-universal --repo OWNER/REPO \
  --set slack_channel=C0123ABCD \
  --set confluence_url=https://your-company.atlassian.net/wiki \
  --set atlassian_username=you@example.com

# 3. Secrets: only those for the sources and provider you use.
azhi secret set atlassian-api-token --value <Atlassian API token>   # Jira and Confluence
azhi secret set github-read-token --value <read-only token>         # or: azhi github login
azhi secret set github-write-token --value <contents + pull requests>
azhi secret set anthropic-api-key --value <key>                     # or: azhi chatgpt login / copilot sign-in
```

Jira and Confluence are read through [mcp-atlassian](https://github.com/sooperset/mcp-atlassian)
(`uvx mcp-atlassian`, read-only, one tool enabled per server) on the worker, so the worker needs
[uv](https://docs.astral.sh/uv/). Skip the three Atlassian settings and the secret if you only use GitHub.

## Run on a ChatGPT or Copilot subscription

OpenCode drives both, so no API key is needed.

```bash
node examples/sdlc-universal/scripts/apply_models.mjs openai-chatgpt   # or github-copilot
azhi chatgpt login      # ChatGPT Plus/Pro: stores the sign-in as secret openai-chatgpt-auth
azhi copilot login      # GitHub Copilot: stores github-copilot-token
```

A subscription has plan limits instead of per-token billing, so cost shows as 0 for ChatGPT-plan steps
(`docs/model-defaults.md`). Which models your plan offers decides what `models.json` can name.

## Run it

```bash
azhi run examples/sdlc-universal -i source=jira   -i ticket=PAY-142 -i confluence_page=123456 -i repo=OWNER/REPO -i base_branch=dev
azhi run examples/sdlc-universal -i source=github -i ticket=OWNER/REPO#28 -i repo=OWNER/REPO -i base_branch=dev
azhi run examples/sdlc-universal -i source=github -i ticket=OWNER/REPO#28 -i repo=OWNER/REPO -i base_branch=dev --provider github-copilot --model gpt-5.6-terra
```

`base_branch` is required: name the branch the ticket was written against. `confluence_page` is optional
and is one numeric page id. You approve twice: the **design**, and the **release**.

## Intake

```
source ─┬─ jira_issue ───┐
        └─ github_issue ─┴─ normalize ──┐
confluence_gate ─ confluence_page ──────┴─ intake ─ dor_check ─ ...
```

`normalize` is the engine's `ticket.normalize` (control and hidden characters removed, title one line).
`intake` (`scripts/merge_context.py`) appends the Confluence page, if there is one, under
`## Linked Confluence context`, trimming the page first so the description stays within 20,000
characters. Every later step reads only `nodes.intake.output`: `source, key, title, description,
priority, reporter, status, labels, url`. Ticket and page text are untrusted data.

A page id must be numeric before the MCP server sees it. The Jira ticket is read by the bundled
`jira.get-issue@1`; the Jira site and the Atlassian token are optional and only needed for a run that reads Jira. For Jira Server or Data Center
the Confluence tool still follows [docs/sdlc.md](../../docs/sdlc.md).

## Models and tokens

Each profile has a `# tier:` line, and `models.json` maps tiers to model names per provider:

| Tier | Roles | Why |
|---|---|---|
| strong | planner (requirements and design in one pass) | the one expensive decision; a good plan makes the build cheap |
| balanced | engineer, reviewer | bounded work from the plan |
| light | readiness check, preflight, test strategist | read and run only |
| alt | finding verifier, criteria auditor | a different model from the reviewer, so they do not share a blind spot |

Names in `models.json` are the ones this repository already uses; edit them to what your account offers.
Token savings come from the structure, not only the tiers: one planning pass instead of two, one reviewer
on a lite path, one fix round, a readiness check before any expensive step, and a preflight that finds a
repository whose tests cannot run before the planner is paid for. To use one model everywhere, run
`apply_models.mjs default` and choose with `--provider`/`--model`, the workflow's `model_defaults`, or the
server default (see [docs/model-defaults.md](../../docs/model-defaults.md)).

## The test gate

A workspace test command is a string of at most 8000 characters (cmd.exe stops at 8191), so
`scripts/gate.js` is carried compressed in `workflow.yaml`. After editing `gate.js`, run
`node examples/sdlc-universal/scripts/build_gate_commands.mjs --write` to put the new commands into
`workflow.yaml`; a test checks they match. `full` runs
install, type-check and tests. `static` runs install, type-check and build, and is used only when the full
tests cannot run on the base branch; the pull request is then tagged `[static-checks-only]` and is a draft.
Unlike v2, static mode does not run the changed test files, because that depends on the test framework.

The gate works for any language and any repository layout. It checks every project it finds, each from its
own folder, and fails if any of them fails. `node -e <command> full plan` prints what it would run without
running it.

The commands come from `.azhi/commands.json` in the repository if present:

```json
{ "install": "mvn -q dependency:resolve", "typecheck": "", "test": "mvn -q test", "build": "mvn -q -DskipTests package" }
```

and, for a repository with several projects in subfolders (a backend, two front ends, a service), a list:

```json
{ "projects": [
  { "dir": "backend", "test": "mvn -B test", "build": "mvn -B -DskipTests package" },
  { "dir": "frontend", "install": "npm ci", "typecheck": "npx tsc --noEmit", "test": "npm test" }
] }
```

Otherwise it detects, at the root and up to two folders below it (not hidden folders, `node_modules`, `vendor`,
`target` or build output): node (npm, pnpm, yarn or bun by lockfile; `typecheck`, `test` and `build` scripts),
Maven, Gradle (their wrapper scripts when present), .NET, Go, Rust, Python (pip, uv or poetry; `pytest`, and a
byte-compile check as the type check), Ruby, PHP, Elixir, Swift, and a `Makefile` with a `test` target. With no
usable command the gate exits 1 and says so.

## Other harnesses

`harness/` holds plain agents, commands and skills (OpenCode's layout, also Claude Code's), so the same
instructions can be reused. Azhi enforces which executor may run what: a step with a `workspace` needs
`executor: opencode` (compile error `workspace_unsupported` otherwise), `claude-agent-sdk` drives only
Anthropic and runs with all built-in tools off, and `codex` is experimental. For Claude Code or any other
tool used by a person, use the `.claude/` layer, which reads and writes the same ticket shape.

## Known limits

- One Confluence page per run; link further pages from that page or from the ticket.
- The test command line is the only repository-specific input; no other repo detail is in the workflow.
- Everything from v2's "Known limits" applies: one fix round, and verification levels
  (no tag, `[static-checks-only]`, `[untested]`) as described in the v2 README.
- Model names in `models.json` are not checked against your account. A wrong one fails at the first
  step that uses it, and `azhi plan` shows each step's model before anything runs.
