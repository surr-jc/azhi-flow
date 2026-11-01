# Choosing the provider and model

Agent steps get their model from a profile (`profiles/<name>@<n>.yaml`). A profile either **names** a
model (`name: claude-opus-5.5`) or says `name: default`, which leaves the choice to the server
(`AZHI_COPILOT_MODEL`, `AZHI_ANTHROPIC_MODEL`, ...). You can now choose the **provider and model for the
default-model steps** of a whole workflow, or of one run, without editing profiles.

**The rule:** a choice applies only to steps whose profile says `name: default` (or leaves the name
out). A step that names its own provider and model keeps them, whatever is chosen.

| Where | What it does |
|---|---|
| Workflow editor, Workflow panel: **Default provider and model** | Saved in the workflow as `model_defaults: {provider, name}`; every run of that version uses it |
| Workflow page, **Start run**: **Model for this run** | Overrides the workflow's default for this one run (and its subworkflows). Remembered in the browser. **Test run** and **Rerun** keep it |
| Start run: **Harness** | Shown once a provider is chosen; every agent step it can drive with that provider runs on it (a step with a checkout stays on OpenCode). Choosing a provider in this panel applies to every step, including steps that name their own model |
| CLI | `azhi run ... --provider github-copilot --model gpt-5.6-terra` (add `--force-model` to replace steps that name their own model, `--executor opencode` for the harness); `azhi plan ... --provider anthropic` shows the plan under a choice |
| API | `POST /v1/runs` with `model_defaults: {provider, name?, force?, executor?}`; `GET /v1/versions/:id/plan?provider=&model=&force=&executor=`; `GET /v1/model-options` and `/v1/model-options/models?provider=` list the providers (ready or not) and models |

Precedence, highest first: the run's choice, the workflow's `model_defaults`, the server's default for
the profile's own provider.

- **Providers:** `anthropic`, `openai`, `github-copilot`, `openai-chatgpt`. A provider alone means that
  provider's server default model; a model needs its provider (a model id means nothing across providers).
- **Credentials:** when the provider changes, the step uses the new provider's own credential
  (`anthropic-api-key`, `github-copilot-token`, ...). A credential a profile names is kept only when the
  provider stays the same.
- **Executors:** the built-in model agent drives Anthropic and OpenAI; OpenCode also drives Copilot and
  ChatGPT plan models. A choice a step's executor cannot drive is marked *unsupported* in the run plan
  and the run is refused before anything executes.
- **The plan shows who decided:** each agent step lists its provider, model and where it came from
  (*named by the step*, *server default*, *workflow default*, *chosen for this run*) in the Models
  section of the workflow page, the editor, and the runner (**Which model each step will use**).

Example: `ai-sdlc` pins the code reviewer, test reviewer, security reviewer and verifier to different
models on purpose. Choosing `github-copilot` / `claude-opus-5.5` for a run changes the analyst, architect,
engineer and the other default-model steps, and leaves those four alone.

# Required configuration is shown before you install

An example's `azhi.config.yaml` marks each setting `required: true` or leaves it optional (with
`needed_for` saying what an optional one is for). Before anything is registered:

- **Marketplace:** the example's page opens with **Before you install**: the required settings and
  repositories (the install is refused without them), the optional ones and what they are for, and the
  secrets you will need before the first run (not to install). Install stays disabled until the
  required ones have a value.
- **CLI:** `azhi example needs <id>` prints the same checklist and the exact command to run;
  `azhi example install <id>` prints it first and stops, changing nothing, when a required value is
  missing.
- **API:** `GET /v1/examples` returns `requirements` for each example; an install without a required
  setting is refused with `missing_settings`.

`ai-sdlc` requires `slack_channel` and `test_command` (which has a default) and the repository; the Jira
site and user are optional, for Jira tickets only.

# Token cost for OpenAI models

Every step that runs an OpenAI model (`provider: openai`, through the built-in model agent, OpenCode or
Codex) gets a cost in USD, in every workflow, with no profile changes. Tokens are priced at a
per-million-token rate; cached input is billed at its own rate and never counted twice. The rate comes
from, highest first:

1. the profile's `pricing` (input and output prices both set),
2. `AZHI_OPENAI_RATES` on the server, e.g. `AZHI_OPENAI_RATES="gpt-5.5=5/0.5/30, my-model=1/4"`
   (`model=input/cached/output`, or `input/output`, USD per million tokens),
3. the cost OpenCode reports from its model catalog (OpenCode steps),
4. the built-in standard-tier table in `src/agents/openai-pricing.ts` (`gpt-5.3-codex`, `gpt-5.4`,
   `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5`).

A model with no rate is shown as *cost unavailable*, never guessed; the same costs feed the run page,
`azhi inspect`, `/v1/usage/summary` and spend budgets. Check platform.openai.com/docs/pricing before
relying on the built-in table, and set `AZHI_OPENAI_RATES` for newer models. ChatGPT plan steps
(`openai-chatgpt`) stay at 0: they use plan limits, not per-token billing.
