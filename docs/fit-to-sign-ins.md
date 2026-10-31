# Fit a workflow to your sign-ins

Before a run, a workflow can be updated to match the providers you are signed in to, and to a harness
and model you pick. A published workflow names a provider that may not be signed in on this machine
(for example a Claude API key, when you only have a ChatGPT plan); this saves editing YAML by hand.

In mission control, open a workflow, then **Fit this workflow to my sign-ins, harness or model** above
the run checks. It shows what each agent step runs on now and what it would run on, and **Update
workflow** saves the change as a new **unsigned draft**. Published versions are never changed.

```sh
# API: report only, or save the draft
POST /v1/versions/:ref/adapt   {"provider":"openai-chatgpt","model":"gpt-5.5","executor":"opencode","save":true}
```

All fields are optional. With none, Azhi keeps what already works and otherwise picks the signed-in
provider the most default-model steps can run on.

## Rules

- Only steps whose profile says `name: default` follow the provider and model (`model_defaults`).
  A step that names its own model keeps it; if its provider is not signed in it is reported
  **blocked** and you change its profile.
- The step's `executor` is changed to one that can drive the provider (Copilot and ChatGPT plan
  need `opencode`). A step with a `workspace` checkout stays on `opencode`.
- A chosen `executor` is a preference: a step it cannot drive keeps one that works.
- The experimental `codex` harness is never picked automatically; choose it explicitly.
- "Signed in" means the provider's credential secret is set. It does not prove the token still works;
  the checks under **Before it starts** and `azhi chatgpt check` do that.
- Needs the `author` role. The planner is `src/plan/adapt.ts`.
