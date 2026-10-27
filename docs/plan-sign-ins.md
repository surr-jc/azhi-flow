# Using a ChatGPT or Claude plan instead of API keys

Agent steps can run on a subscription you already pay for, as long as the step uses the runtime
the plan's owner allows.

| Plan | Step executor | Profile `model.provider` | Credential |
|---|---|---|---|
| ChatGPT Plus, Pro, Business | `opencode` | `openai-chatgpt` | `openai-chatgpt-auth`, from `azhi chatgpt login` |
| Claude Pro, Max | `claude-agent-sdk` | `anthropic` | a plan token from `claude setup-token` |
| GitHub Copilot | `opencode` | `github-copilot` | `github-copilot-token`, from `azhi copilot login` |

## ChatGPT plan (OpenCode steps)

OpenAI supports ChatGPT plans in OpenCode. Azhi signs in the way OpenCode's own "ChatGPT Pro/Plus
(headless)" login does:

```sh
npx azhi chatgpt login     # open the link, enter the code, sign in with your ChatGPT account
npx azhi chatgpt check     # renews the sign-in once and says whether it works
```

or **Secrets > ChatGPT plan > Sign in with ChatGPT** in mission control. Then in a profile:

```yaml
model: {provider: openai-chatgpt, name: default, credential: openai-chatgpt-auth}
```

`default` is the server's `AZHI_CHATGPT_MODEL` (`gpt-5.5` unless set). A model your plan does not
offer fails the step with the list it does offer.

- Azhi renews the sign-in itself: when a step starts and the access token has less than an hour
  left, the server renews it and saves the new tokens. If a step outlasts the token, OpenCode
  renews it and the worker sends the new tokens back.
- OpenAI replaces the refresh token on every renewal. Give Azhi its own sign-in: do not paste
  Azhi's into your own OpenCode or Codex, or theirs into Azhi, or each will cancel the other.
- Cost: a ChatGPT plan has no per-token charge, so these steps record a cost of 0 (`reported`,
  "ChatGPT plan"). Token counts are still recorded. When the plan's usage limit is reached the
  step fails and says so; it resets on OpenAI's schedule.
- OpenCode steps run on Linux, macOS and native Windows workers (Windows is new and not yet checked by a live run; WSL also works).
- **Build with chat:** once signed in, the builder's Provider list has **OpenCode (ChatGPT plan)**.
  The builder calls OpenAI's Codex endpoint the way OpenCode does (no OpenCode process needed), and
  the profiles it drafts use `provider: openai-chatgpt` on `executor: opencode` steps. Its model list
  is the fixed list OpenCode offers on a ChatGPT plan; your plan may not include every model.

## Claude plan (Claude Agent SDK steps)

Anthropic's terms do not allow a Claude Pro or Max plan in third-party tools such as OpenCode. They
do allow it through Claude Code's Agent SDK, which is what the `claude-agent-sdk` executor runs, for
your own use.

```sh
claude setup-token                                  # on any machine with Claude Code; prints sk-ant-oat...
npx azhi secret set claude-plan-token --value <token>
```

Profile and node:

```yaml
# profiles/<name>@1.yaml
model: {provider: anthropic, name: default, credential: claude-plan-token}
```

```yaml
# workflow.yaml, on the agent node
executor: claude-agent-sdk
```

- A plan token goes to Anthropic directly (`AZHI_ANTHROPIC_API_URL` is not used for it).
- Azhi refuses a plan token on `model-agent` and `opencode` steps, which call the API directly.
- `workspace` checkouts and `harness.opencode` setups are OpenCode-only, so steps that need them
  (the pr-review reviewers) cannot move to a Claude plan.
- Cost is from the profile's `pricing` if you set it (an API-equivalent estimate), otherwise
  unavailable. Usage counts against the plan's limits.
- This is for your own Azhi with your own plan. A hosted Azhi serving other people must use API keys.
