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

## Model provider

The builder uses the workspace's own key: `anthropic-api-key` or `openai-api-key` (Governance ›
Secrets). When both are set you can choose in the page.

| Setting | Effect |
|---|---|
| `AZHI_BUILDER_PROVIDER` | `anthropic` or `openai`: the default when both keys are set |
| `AZHI_BUILDER_MODEL` | Model for the builder (for `AZHI_BUILDER_PROVIDER`, or for either when that is unset) |
| `AZHI_ANTHROPIC_MODEL` / `AZHI_OPENAI_MODEL` | Used when `AZHI_BUILDER_MODEL` is unset; Anthropic falls back to `claude-sonnet-5-5` |

## The skill

The builder's instructions are a skill file, [src/builder/skill.md](../src/builder/skill.md): how
to interview, the workflow.yaml reference (every node type, values and CEL, profiles), the rules
the compiler enforces (taint gate, registered tools, schemas, files), and the controls to offer
(approvals, guards, budgets, pinned datasets, scripts for numbers). Edit it to change how the
builder behaves; it is read when the server starts.

## API

- `GET /v1/builder`: providers, whether each is ready, and the model.
- `POST /v1/builder/chat` `{messages, text, provider?}`: runs one turn; returns the new transcript
  and an event (`questions`, `proposal` or `text`).
- `POST /v1/builder/save` `{files, new_version_of?}`: re-checks and saves the proposal as an
  unsigned draft.
