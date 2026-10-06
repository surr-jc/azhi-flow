# Pull request review with OpenCode agents

`examples/pr-review` reviews one GitHub pull request with four OpenCode reviewers and a
summarizer, and can post the review as a PR comment after a person approves it.

```
pr (GitHub PR + files) ─┬─ correctness ─┐
                        ├─ security ────┤
                        ├─ tests ───────┼─ summarize ─ report
                        └─ quality ─────┘      └─ should_post ─ approve_post ─ post (PR comment)
```

| Node | What it does |
|---|---|
| `pr` | `github.get-pull-request@1`: title, body, author, base and head refs and SHAs, changed files with line counts |
| `correctness`, `security`, `tests`, `quality` | OpenCode agents, each in its own fresh checkout of `refs/pull/<n>/head`, returning findings (`schemas/findings.json`) |
| `summarize` | OpenCode agent without a checkout: merges the findings into a verdict, findings and a Markdown body (`schemas/review.json`) |
| `report` | The review as a run artifact (`templates/review.md`) |
| `should_post` → `approve_post` → `post` | Only when the run input `post` is true: a person approves the exact body, then `github.comment-on-pr@1` posts it. The comment is ledgered and deduplicated, and its CEL guard only allows the PR under review |

## The agents' setup (profile `harness.opencode`)

Each reviewer profile names files from the package. Azhi turns them into OpenCode's own
mechanisms in a config folder outside the checkout (`OPENCODE_CONFIG_DIR`):

```yaml
harness:
  opencode:
    agent: harness/agents/security.md          # agent prompt (OpenCode agent, mode primary)
    command: harness/commands/review.md         # first turn (OpenCode command)
    skills: [harness/skills/review-checklist, harness/skills/security-checklist]   # OpenCode skill tool
    tools: [read, grep, glob, skill]            # built-in tools allowed; read-only only
    mcp:
      repo-facts: {command: [node, harness/mcp/repo-facts.mjs]}   # local stdio MCP servers
```

- **Agent**: Azhi writes the frontmatter itself (`mode: primary`, description), so a package file
  cannot switch tools or permissions back on. The prompt is the Azhi system prompt (platform rules
  and the profile `instructions`) followed by the file's body.
- **Command**: run as the first turn. The step input is sent just before it as its own message.
  Templates may not use `$ARGUMENTS`, `$1`… or `` !`shell` ``: OpenCode runs shell commands found
  in a command template after substituting its arguments, so untrusted text never goes through
  them (verified: a PR body with `` !`touch …` `` passed as an argument ran the command).
- **Skills**: copied to `skill/<name>/`; the model loads one with the `skill` tool when it needs it.
- **Tools**: only `read`, `grep`, `glob` and `skill` may be allowed. `bash`, `edit`, `write`,
  `webfetch`, `task` and the rest stay off, every permission is `deny`, and reads outside the step
  folder are refused (`external_directory: deny`).
- **MCP servers**: local processes from the package, started with the checkout's isolated
  environment plus `AZHI_WORKSPACE` (the checkout path). `repo-facts` is dependency-free and offers
  `changed-files` and `file-diff` against the PR base. The run plan marks MCP servers
  *unobservable*: their calls do not go through the gateway or the ledger.
- The gateway bridge (`submit_output` and any gateway tools) is unchanged.

The compiler checks every path exists, refuses write tools and templates with arguments or shell,
and only accepts `workspace` with `executor: opencode`.

## The isolated checkout (`workspace` on an agent node)

```yaml
workspace:
  repo: {ref: inputs.repo}                                   # owner/name
  ref: {cel: "'refs/pull/' + string(inputs.pr) + '/head'"}
  base_ref: {cel: "'refs/heads/' + nodes.pr.output.base_ref"}   # fetched as refs/azhi/base
  credential: github-read-token                              # optional workspace secret
  # host: https://github.com   (default; GitHub Enterprise: https://ghe.example.com)
  # depth: 50                  (shallow fetch; full history by default)
```

For each step the worker:

1. Makes a fresh temporary root (`azhi-opencode-*`) with its own `home/`, `config/` and `repo/`.
2. Runs git with nothing from the host but `PATH`: `HOME` is the step's own, system and global
   git config are ignored, no credential helper, no terminal prompts, hooks off, only the URL's
   protocol allowed (https, or http on loopback for local git servers).
3. Fetches by URL (no remote is saved). The token, fetched from the server with the run token,
   lives only in that one command's environment as an auth header scoped to the host. It is not
   written to `.git/config` or anywhere in the checkout and never reaches the model.
4. Checks out with `core.symlinks=false`, so a symlink in the repository is a plain file and
   cannot point a read tool at the host.
5. Starts OpenCode in the checkout with `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE`
   and `OPENCODE_DISABLE_EXTERNAL_SKILLS`, so the repository's `opencode.json`, `.opencode/`,
   `AGENTS.md`, `CLAUDE.md` and `.claude/skills` are ignored.
6. Deletes the whole root when the step ends, whether it succeeded, failed or was cancelled.

The four reviewers clone separately, so they can run in parallel on different workers. Agents
with a workspace are tainted ("reads a cloned repository"), so any write downstream needs an
approval, a CEL guard or a safe-for-tainted tool. The context manifest records the checkout and
the package files OpenCode loaded; what the agent read in the checkout is not observable.

### The code quality reviewer and its skill

`quality` loads the `thermo-nuclear-code-quality-review` skill from Cursor's plugins repository
(`harness/skills/thermo-nuclear-code-quality-review/`): a strict maintainability review (abstraction
quality, files growing past 1000 lines, spaghetti branching). `SKILL.md` is copied unmodified; its
MIT `LICENSE` and a `SOURCE.md` (source URL, fetch date, SHA-256) sit next to it. It is guidance
only: it asks for no commands or network, and the reviewer has the same read-only tools as the
others. The reviewer's own prompt (`harness/agents/quality.md`) caps its findings at `major`
(`blocker` only for a defect that also breaks behaviour), so style never blocks on its own. To drop
it, remove the `quality` step and its entry in `summarize`'s input in the editor; to tune it, edit
that agent prompt, not `SKILL.md`. To update the skill, replace `SKILL.md` from the source, read it
again, and update `SOURCE.md`.

## Run it

Needs a worker with OpenCode (bundled with `npm install`) and git, a GitHub Copilot subscription
for the models, and two GitHub tokens:

- `github-copilot-token`: your Copilot sign-in. All four agents run on GitHub Copilot models
  through OpenCode's own `github-copilot` provider; no Anthropic or OpenAI key is involved.
- `github-read-token`: fine-grained, read-only **Contents** and **Pull requests** on the repository.
- `github-comment-token`: **Pull requests: write**, used only by the approved comment step.

For a repository owned by an organization, the tokens must be made for that organization:

- Fine-grained token: set **Resource owner** to the organization (not your account), then pick the
  repository. If the organization requires approval, the token stays pending until an owner
  approves it (Organization settings > Personal access tokens > Pending requests). If the
  organization does not offer itself as a resource owner, it has turned fine-grained tokens off.
- Classic token instead (when the organization allows only those): scope `repo`, then
  **Configure SSO** > **Authorize** next to the organization if it uses SAML single sign-on.
- With Enterprise Managed Users, create the tokens while signed in as your managed (`_shortcode`)
  account; a personal account cannot reach the organization's repositories.

Check a token before saving it: `curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/OWNER/REPO`
returns the repository's JSON, not `Not Found`.

On GitHub Enterprise Server or a GHE.com subdomain, give the API address at Install (*GitHub
Enterprise* on the Examples card, or `--api-url https://HOST/api/v3`). Install then also points the
checkouts at that host; *Git address* (`--git-url`) sets a different clone host. A server on a
private address also needs `AZHI_EGRESS_ALLOW=HOST` when starting Azhi.

### GitHub Copilot models

The profiles say `model: {provider: github-copilot, name: default, credential: github-copilot-token}`.
`default` is the server's `AZHI_COPILOT_MODEL` (`claude-sonnet-5` unless set); put any model your
Copilot plan offers in `name` instead (Workflows → Edit → reviewer step → Model). Copilot bills
the tokens in AI Credits (see *Cost* below).

Signing in uses GitHub's device flow with OpenCode's own OAuth app (the one `opencode auth login`
uses, so Copilot accepts the token from OpenCode): **Sign in with GitHub Copilot** on the Examples
card or the Secrets page, or `azhi copilot login`, shows a code to enter at github.com/login/device.
The server stores the token GitHub returns as the secret `github-copilot-token`; it is never shown.
If you already signed in with `opencode auth login`, you can instead paste the token, or the whole
`~/.local/share/opencode/auth.json`, as that secret.

On the worker the sign-in reaches OpenCode only in memory (`OPENCODE_AUTH_CONTENT`), never on disk,
and is removed from the environment of the package's MCP servers (OpenCode passes its own
environment to them). Copilot models run only through OpenCode: the built-in model agent refuses
a `github-copilot` profile, and the run plan says so.

**Cost.** Copilot's usage-based billing (since June 1, 2026) meters chat and agent use in GitHub
AI Credits, 1 credit = USD 0.01: tokens at the model's per-million-token rate (input, cached input,
cache write, output), drawn from the organization's monthly pool (Enterprise: 3,900 per seat; the
pool resets on the 1st, 00:00 UTC). Past the pool, usage is charged at the same rates when
additional usage is allowed, or blocked. Azhi prices each Copilot step that way
(`src/agents/copilot-pricing.ts`) from the tokens OpenCode reports (its input count excludes cached
tokens) and records the credits on the usage record. The run's usage (web UI Usage tab,
`azhi inspect`, `GET /v1/runs/:id` → `usage.copilot`) shows credits per model, their value, and,
with a pool size, the credits this workspace's Copilot steps used earlier in the month, what is
left and what fell past the pool. Azhi sees only its own runs, not IDE use of the same pool.
Mission control's Usage page and spend limits count the value like any estimated cost.

The signed-in user's own allowance, as VS Code and OpenChamber show it, comes from GitHub's
internal `copilot_internal/user` endpoint with the Copilot sign-in (no admin rights):
`azhi copilot quota` (`--shape` prints the answer's field names, never the token or text values),
`GET /v1/copilot/quota` (operator), and a line on the run's Usage tab. It is undocumented, so
fields are read loosely; the billing REST API (`/organizations/ORG/settings/billing/ai_credit/usage`)
is the documented route but needs an organization admin or billing manager.

| Setting | Default | Meaning |
|---|---|---|
| `AZHI_COPILOT_CREDIT_POOL` | unset | the organization's monthly AI credit pool |
| `AZHI_COPILOT_RATES` | GitHub's table (June 2026) | `model=input/output`, `input/cached/output` or `input/cached/cache_write/output`, USD per million tokens, comma separated; extend and override the table |
| `AZHI_COPILOT_CREDIT_USD` | `0.01` | USD per credit, if a contract prices it differently |
| profile `pricing.input_per_mtok` etc. | unset | per-profile rates |

The built-in table (claude-haiku-4.5, claude-sonnet-4/4.5/4.6/5, claude-opus-4.5/4.6/4.7,
gpt-5-mini) was taken from search excerpts of GitHub's "Models and pricing for GitHub Copilot"
page; check it there. A model without a rate has no cost (unavailable) and is named in the run's
usage. The budget `max_cost_usd` is not enforced inside a Copilot step (tokens are known when it
ends); the run plan says so.

Setup needs no file editing; do it from either place.

**Web UI** (Mission Control, admin role):

1. **Examples** → *Pull request review (OpenCode)*: type the repositories its GitHub tools may use
   (`owner/name`; GitHub Enterprise: open *GitHub Enterprise* and give the API address),
   then **Install**. This registers both GitHub tools with those repositories, saves the package as
   a draft and signs it with a publisher key made in this browser (WebCrypto Ed25519, kept
   non-extractable in IndexedDB, certified once by the workspace root).
2. On the same card, click **Sign in with GitHub Copilot** and enter the code it shows at
   github.com/login/device, then fill in the two GitHub tokens; values are never shown again.
3. **Open it**, check the run plan, fill in Repository, Pull request number and Post, and **Start run**.

**CLI**:

```
azhi example list
azhi example install pr-review --repo OWNER/REPO        # --repo again for more; --api-url (and --git-url) for GHE
azhi copilot login                                       # shows a code for github.com/login/device
azhi secret set github-read-token
azhi secret set github-comment-token
azhi run <version-id> --published -i repo=OWNER/REPO -i pr=123 -i post=false --wait
```

`example install` prints the draft's version id and signs it with this machine's key
(`~/.azhi/keys`). With `post=true` the run waits on `approve_post`; approve it in Approvals or with
`azhi approve <run-id> approve_post`.

### Changing the agents in the editor

In **Workflows** → pr-review → **Edit**, select a reviewer. With executor `opencode` the step shows:

- **Workspace**: repository, ref and base ref (plain text or `{ref: ...}` / `{cel: ...}`), the clone
  credential secret, host and depth.
- **OpenCode setup** (in the profile): the agent prompt and first command files with their text
  (a command using `$ARGUMENTS`, `$1` or `` !`shell` `` is flagged at once), skills (tick, edit, or
  create one), the read-only built-in tools, MCP servers (name and command), and every other
  `harness/` file, including MCP server scripts.

Saving checks everything with the compiler, stores a new draft with the edited files and signs it
in the browser. An upload from **Upload a workflow** is signed the same way. If this browser cannot
sign (no Ed25519 support, or a non-local `http://` address), the workflow page shows **Sign** for
the draft, or use `azhi publish`.

## When a step fails

The run page and `azhi inspect <run-id>` show each step's error. For OpenCode steps:

- `model 'X' is not available on this GitHub Copilot sign-in. Available: ...`: your Copilot plan
  (or your organization's Copilot policy) does not offer that model. Pick one from the list and set
  `AZHI_COPILOT_MODEL` before `azhi up`, or the reviewer's Model in the editor.
- Any other OpenCode failure names the cause from OpenCode's log and ends with
  `(OpenCode log: ~/.azhi/logs/opencode/<run>-<step>-<time>.log)`. The step's own folder is deleted
  when the step ends, so that saved copy is the only one. `ls -t ~/.azhi/logs/opencode | head` lists
  the newest; `grep -h err_XXXX ~/.azhi/logs/opencode/*.log` finds an error reference.
- `GitHub Copilot refused the saved sign-in` (or `AI_APICallError: Unauthorized` in the OpenCode log):
  Copilot does not accept the saved `github-copilot-token`. Run `azhi copilot check` (or **Check
  sign-in** on the Examples page): it asks GitHub and says whether the token is revoked (sign in
  again), or whether the GitHub account has no Copilot seat or its organization restricts OAuth
  apps (an owner approves the "opencode" app, then sign in again). Sign in with the account that has
  Copilot; do not paste a token by hand.
- `azhi copilot check` fails although your own OpenCode works with Copilot: the check makes the same
  requests OpenCode does with the saved sign-in (the model list, then a one-token chat with the
  configured model) and prints each answer, so it shows the difference. The simplest fix is to reuse
  your OpenCode's own sign-in: `azhi copilot import` tries every Copilot sign-in on the machine (each
  github-copilot entry in `~/.local/share/opencode/auth.json`, kept whole with its enterprise address,
  then `GITHUB_TOKEN`/`GH_TOKEN`, then `gh auth token`), prints which work, and saves the first that
  Copilot accepts (nothing if none does), also trying each entry's `access` token (some OpenCode versions
  send that one); no token is printed. `azhi copilot inspect` shows the shape of the entry (field names,
  token kind and length, expiry), never a token. A GitHub CLI sign-in (`gh auth token`) works with Copilot
  where a token from the OpenCode device flow may be refused; import picks it up (re-import after `gh auth login`). The web UI takes the pasted file. If your company signs in to its own GitHub address (a name like
  `octo.ghe.com`), `azhi copilot login --enterprise-url octo.ghe.com` signs in there. Import again
  whenever your OpenCode signs in again.
- `gateway bridge did not connect to opencode: ... Operation timed out after 30000ms` (older builds):
  OpenCode gives its MCP servers 30 seconds to start, and on a slow or virus-scanned machine the
  first start of Azhi's bridge took longer. The bridge now loads only what it needs and is given
  120 seconds; update (`git pull && npm ci`), restart `azhi up` and run again.
- Azhi's own server and worker messages are in the window running `azhi up`.

For a GitHub step:

- `repo OWNER/NAME is not one of the repositories this tool may use (...)`: the example's GitHub
  tools only accept the repositories given at Install. Add more without reinstalling, either on
  **Examples** under *Allowed repositories* on the installed card, or with
  `azhi example repos pr-review --add OWNER/NAME` (`--remove` takes one off; with no flags it lists
  them). This saves a new revision of each GitHub tool; runs started afterwards use it. For a
  single tool, `azhi tool repos <tool@version> --add OWNER/NAME` does the same. The
  github-read-token and github-comment-token must also have access to that repository (for an
  organization repository, the organization may need to approve the token or authorize it for SSO).

## What is verified

`test/pr-review.test.ts` runs the whole workflow with OpenCode 1.18.34 and its real
`github-copilot` provider pointed at a scripted Copilot stand-in (`AZHI_COPILOT_API_URL`; no
subscription, no network), a stand-in for GitHub's device flow, a local git host
(`git http-backend` behind a token check) and a stand-in GitHub API. It checks:

- the structured review, every reviewer's findings, the approval request and the posted comment
  (with its dedupe marker); with `post=false` the approval and comment are skipped;
- the agent prompt, command, skills, `repo-facts` diff output and the exact tool list reach the
  model (no `bash`, `edit`, `write`, `webfetch`); the summarizer gets only `skill`;
- the checkout is the PR head; the token is sent to the git host and is not in the checkout,
  `.git/config`, the MCP server environment or anything sent to the model;
- the host's `GH_TOKEN` and a global git config with an extra header and a URL rewrite have no
  effect; a repository symlink to a host file is not followed; reads outside the checkout are
  denied; the repository's `AGENTS.md`, `opencode.json` and `.opencode/skill` are ignored;
- shell syntax in the PR body is not run; the checkout folder is gone after the step;
- the run plan and the context manifest describe the checkout, tools and MCP servers;
- every model call carries the Copilot sign-in as its bearer token (as OpenCode sends it to
  Copilot), the sign-in is in no request body, and a package MCP server does not see it or
  OpenCode's server password in its environment;
- a model the sign-in does not offer fails the step with the available models listed and the
  OpenCode log saved under `~/.azhi/logs/opencode/`;
- Copilot sign-in through the API, `azhi copilot login` (real CLI) and the Examples page: the code
  is shown, the token is stored as a secret and never returned, and only admins can start it;
- setup without editing files: `azhi example install` (run as the real CLI) registers the tools
  with the given repositories and signs the draft; in Chromium, the Examples page installs, signs
  in the browser, sets a secret and starts a run that completes; the editor changes the workspace,
  command, skills, tools, MCP servers and harness files and saves a signed draft; unsigned drafts
  show the worker trust blocker until signed; harness file paths outside `harness/` are refused.

Not verified: a run against GitHub Copilot itself (the real device flow, Copilot's model list,
review quality, whether a real model follows the command and uses the tools well), Copilot for
GitHub Enterprise (data residency) sign-in, which `azhi copilot login` does not offer yet, cloning from github.com itself, and GitHub's real API responses for the
PR and comment calls (the tools follow the documented REST shapes). A worker that crashes mid-step
leaves its temporary folder behind. A subprocess is not a sandbox: MCP servers and git run as the
worker's user, so packages with MCP servers should come from trusted authors.
