# Workflow builder chat

Workflows › Workflows › **Build with chat** (`/ui/workflows/new`) turns a requirement into a
workflow package by conversation. Authors and above can use it.

## What happens

1. You describe what the workflow should do.
2. The builder looks at the workspace (registered tools and their schemas, datasets, existing
   workflows, the shipped examples, executors, and whether the well-known secrets are set; never
   their values).
3. It asks grouped questions with suggested answers (trigger, data sources, where a person must
   approve, budgets, delivery). You pick options, write your own answer, or say "just draft it".
4. It proposes the whole package (workflow.yaml, agent profiles, schemas, templates, small
   scripts). The server compiles it and builds its run plan against the workspace, exactly as an
   upload would. Compiler errors go back to the model to fix; you only see drafts that compile.
5. The draft panel shows the steps, the files, and what must be set up before it can run (missing
   secrets, datasets, tools, server settings).
6. **Save draft and open the editor** stores it as an unsigned draft version and opens the visual
   editor. Publishing still needs your signature. Ask the builder for changes at any point; a
   proposal for an existing workflow id is saved as a new draft version only when you asked to
   change that workflow.

The conversation stays in your browser tab; the server keeps no transcript. Each turn is in the
audit log (`builder.turn`, with provider, model and token counts) and each save as
`builder.saved`. Builder calls are not part of any run, so run budgets do not apply to them.

## Provider and model

Above the chat, pick the provider and the model: Anthropic, OpenAI, or OpenCode (GitHub
Copilot). One that cannot be used here is shown disabled with the reason (no key or sign-in yet).
The model list is the provider's own, read with the workspace key (`GET /v1/models` at Anthropic
and OpenAI; chat models only for OpenAI), with a built-in list for Anthropic when that call fails. One model is marked **Recommended** with the
reason; you can pick any other, or choose "Other model id…" and type one. The choice is
remembered in this browser.

Recommended: Claude Opus 5.5 for Anthropic; for OpenAI, `AZHI_OPENAI_MODEL` when set, else the
newest full-size GPT model your key lists; for OpenCode, the newest Claude Opus your Copilot seat
offers (else the newest Sonnet, else `AZHI_COPILOT_MODEL`).

### OpenCode (GitHub Copilot)

OpenCode uses the GitHub Copilot sign-in that OpenCode steps use (secret `github-copilot-token`,
from **Sign in with GitHub Copilot** under Governance › Secrets, or `azhi copilot login` /
`azhi copilot import`). The builder does not start the OpenCode program: it calls Copilot's API the
way OpenCode does (the sign-in as the bearer token, OpenCode's user agent, `copilot-api.<host>`
for a GitHub Enterprise sign-in), because the builder needs its own tools and its own stop when it
asks you a question. The model list is Copilot's `GET /models` for that sign-in, keeping chat
models that take tool calls and that your organization has not switched off; when it cannot be
read, the models Azhi has Copilot prices for are shown.

Limits:

- Builder turns use your Copilot allowance (AI Credits), like any other Copilot chat. A message
  you send counts as a request; the builder's own lookup rounds are marked as agent rounds, as
  OpenCode marks them.
- Copilot has to give the model tool calls on its chat API; a model that only answers on another
  endpoint is left out of the list. Typing one under "Other model id…" fails with Copilot's error.
- Drafts made this way use `provider: github-copilot` profiles on agent nodes with
  `executor: opencode`, which run only on Linux or macOS workers. The compiler checks them as usual,
  and an OpenCode command template may not contain `$ARGUMENTS`, `$1`-style placeholders or
  `` !`shell` `` lines (OpenCode would run them on the step's input).

| Setting | Effect |
|---|---|
| `AZHI_BUILDER_PROVIDER` | `anthropic`, `openai` or `opencode`: the default when several are set up |
| `AZHI_BUILDER_MODEL` | The model used when the browser has not picked one |

## The skill

The builder's instructions are a skill file, [src/builder/skill.md](../src/builder/skill.md): how
to interview, the workflow.yaml reference (every node type, values and CEL, profiles), the rules
the compiler enforces (taint gate, registered tools, schemas, files), and the controls to offer
(approvals, guards, budgets, pinned datasets, scripts for numbers). Edit it to change how the
builder behaves; it is read when the server starts.

## API

- `GET /v1/builder`: providers, whether each is ready (and why not), and the default model.
- `GET /v1/builder/models?provider=anthropic|openai|opencode`: the model list, the recommended model and why.
- `POST /v1/builder/chat` `{messages, text, provider?, model?}`: runs one turn; returns the new transcript
  and an event (`questions`, `proposal` or `text`).
- `POST /v1/builder/save` `{files, new_version_of?}`: re-checks and saves the proposal as an
  unsigned draft.
