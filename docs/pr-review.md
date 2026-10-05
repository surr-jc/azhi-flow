# Pull request review with OpenCode agents

`examples/pr-review` reviews one GitHub pull request with three OpenCode reviewers and a
summarizer, and can post the review as a PR comment after a person approves it.

```
pr (GitHub PR + files) ─┬─ correctness ─┐
                        ├─ security ────┼─ summarize ─ report
                        └─ tests ───────┘      └─ should_post ─ approve_post ─ post (PR comment)
```

| Node | What it does |
|---|---|
| `pr` | `github.get-pull-request@1`: title, body, author, base and head refs and SHAs, changed files with line counts |
| `correctness`, `security`, `tests` | OpenCode agents, each in its own fresh checkout of `refs/pull/<n>/head`, returning findings (`schemas/findings.json`) |
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

The three reviewers clone separately, so they can run in parallel on different workers. Agents
with a workspace are tainted ("reads a cloned repository"), so any write downstream needs an
approval, a CEL guard or a safe-for-tainted tool. The context manifest records the checkout and
the package files OpenCode loaded; what the agent read in the checkout is not observable.

## Run it

Needs a worker with OpenCode (bundled with `npm install`) and git, an Anthropic key (OpenCode
drives Anthropic models only), and two GitHub tokens:

- `github-read-token`: fine-grained, read-only **Contents** and **Pull requests** on the repository.
- `github-comment-token`: **Pull requests: write**, used only by the approved comment step.

Setup needs no file editing; do it from either place.

**Web UI** (Mission Control, admin role):

1. **Examples** → *Pull request review (OpenCode)*: type the repositories its GitHub tools may use
   (`owner/name`; GitHub Enterprise: open *GitHub Enterprise Server* and give the API address),
   then **Install**. This registers both GitHub tools with those repositories, saves the package as
   a draft and signs it with a publisher key made in this browser (WebCrypto Ed25519, kept
   non-extractable in IndexedDB, certified once by the workspace root).
2. Fill in the three secrets on the same card; values are sent once and never shown again.
3. **Open it**, check the run plan, fill in Repository, Pull request number and Post, and **Start run**.

**CLI**:

```
azhi example list
azhi example install pr-review --repo OWNER/REPO        # --repo again for more; --api-url for GHE
azhi secret set anthropic-api-key
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

## What is verified

`test/pr-review.test.ts` runs the whole workflow with OpenCode 1.18.34 against a scripted
Anthropic endpoint (no key, no network), a local git host (`git http-backend` behind a token
check) and a stand-in GitHub API. It checks:

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
- setup without editing files: `azhi example install` (run as the real CLI) registers the tools
  with the given repositories and signs the draft; in Chromium, the Examples page installs, signs
  in the browser, sets a secret and starts a run that completes; the editor changes the workspace,
  command, skills, tools, MCP servers and harness files and saves a signed draft; unsigned drafts
  show the worker trust blocker until signed; harness file paths outside `harness/` are refused.

Not verified: a run with a live model (review quality, whether a real model follows the command
and uses the tools well), cloning from github.com itself, and GitHub's real API responses for the
PR and comment calls (the tools follow the documented REST shapes). A worker that crashes mid-step
leaves its temporary folder behind. A subprocess is not a sandbox: MCP servers and git run as the
worker's user, so packages with MCP servers should come from trusted authors.
