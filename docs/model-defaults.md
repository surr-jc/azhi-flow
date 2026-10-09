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
| CLI | `azhi run ... --provider github-copilot --model gpt-5.6-terra`; `azhi plan ... --provider anthropic` shows the plan under a choice |
| API | `POST /v1/runs` with `model_defaults: {provider, name?}`; `GET /v1/versions/:id/plan?provider=&model=`; `GET /v1/model-options` and `/v1/model-options/models?provider=` list the providers (ready or not) and models |

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
