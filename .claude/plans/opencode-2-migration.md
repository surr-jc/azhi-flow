# Spike: moving the OpenCode harness from OpenCode 1.x to OpenCode 2

Checked 2026-10-25 against `@opencode/cli@2.1.4` and `@opencode/client@2.1.4`, installed in a scratch folder
(not in `package.json`). Everything ran natively on Windows 11 (x64), where the worker runs. The probe scripts
and their raw output are in the shared notes folder
`%APPDATA%/Claude/side-session-notes/local_10ddf859-5b66-4502-bbff-250e53ecbe8f/opencode-2-probe/`:

| Probe | What it does |
| --- | --- |
| `start.mjs` | starts `opencode serve --port 0 --hostname 127.0.0.1 --print-logs` with the same isolated env as `harness-activity.ts` |
| `api.mjs` (`api-v1.json`, `api-v2.json`) | password check, config loading (1.x and 2.x shapes), providers, models, MCP status, agents, commands, skills |
| `tools.mts` (`tools-all.json`) | which tools the model is offered under 15 tool-restriction configs (against `src/testing/fake-anthropic.ts`) |
| `dump.mjs` (`dump-false.json`) | the full tool list (names and descriptions) OpenCode sends to the model |
| `session.mts` (`session-v2.json`) | a real session against the fake Anthropic endpoint: prompt, MCP tool calls, tokens, queued input plus command, interrupt, events |
| `creds.mjs` (`creds.json`) | Copilot and ChatGPT integrations, `OPENCODE_AUTH_CONTENT`, legacy `auth.json`, `credential.create`, `OPENCODE_CONFIG_CONTENT` |

The Azhi conformance suite (`test/opencode.test.ts`) was **not** run against 2.x: it needs the code changes below.

## Which v2 package

`npm view @opencode/sdk@2.1.4 description` says it is an "In-process OpenCode host ... opening no listener"
that runs the server router inside the caller, and it depends on `@opencode/server` and `@opencode/core`. That
would put OpenCode, its tools and its MCP children inside the Temporal worker's process, outside the per-step
HOME, env and process-tree kill. It conflicts with the isolation model. **Use `@opencode/client` (a fetch-based
client) against a separate `opencode serve` per step, as today.** Confirmed: the probes drive a spawned v2 server
with `OpenCode.make({ baseUrl, headers })` and nothing else.

## Dependency table

Legend: **works**: unchanged; **changed**: works with the change described; **gone**: removed in 2.x, with the workaround.

| What the harness relies on | 2.1.4 | Evidence |
| --- | --- | --- |
| Binary from npm, Windows native | **changed**: package `@opencode/cli` (+ `@opencode/cli-windows-x64`, a 247 MB binary); the program is `node_modules/@opencode/cli/bin/opencode.exe` (bins `opencode` and `opencode2`). Same `bin/opencode.exe` layout as `opencode-ai`, so `opencodeBinary()` only needs the new path. All probes ran on Windows. | `npm view @opencode/cli@2.1.4 bin optionalDependencies`; `ls node_modules/@opencode/cli/bin` |
| `opencode --version` | **changed**: prints `opencode v2.1.4` (1.18.34 prints `1.18.34`). `detectCapabilities` would report the version as `opencode v2.1.4`, so `harness.version` becomes `opencode@opencode v2.1.4` unless it is parsed. | ran both binaries |
| `opencode serve --port 0 --hostname 127.0.0.1 --print-logs` prints its URL | **works**: prints `server listening on http://127.0.0.1:<port>` within about 0.6 s, which `serverUrl()`'s regex matches; `--port 0` gives a random port. `serve` without `--service` is a private server, not the background service. | `serve --help`; `start.mjs` |
| Basic-auth password protection | **works**: `OPENCODE_SERVER_PASSWORD` (or the new `OPENCODE_PASSWORD`) is read. No auth → 401, `opencode:<pw>` → 200, a wrong user or password → 401. Without a password the server makes up a random one; it never runs open. | `api.mjs` (`noAuth`, `basic_opencode`, `basic_x`, `wrongPw`); binary code `C4("OPENCODE_PASSWORD").pipe(y6(()=>C4("OPENCODE_SERVER_PASSWORD")))` |
| `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` | **works**: both are loaded (`config.get` lists the file and the directory). New: `OPENCODE_CONFIG_CONTENT` is read as an in-memory config document. | `api.mjs` `config`; `creds.mjs` `configDocs` (username from content) |
| `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE` | **works**: both are still read (plus new aliases `OPENCODE_CONFIG_PROJECT_DISABLE`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`). | `grep -a` of the binary's env-to-config mapping |
| `OPENCODE_DISABLE_AUTOUPDATE` | **works**: still read; config `autoupdate: false` becomes `update: "disable"`. | binary strings; v1 config translated to `update: "disable"` |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_LSP_DOWNLOAD` | **gone**: neither name appears in the 2.1.4 binary. Workaround: skills come only from `OPENCODE_CONFIG_DIR` plus OpenCode's two bundled skills (`opencode`, `report`) in the probe; disable the bundled ones explicitly if a profile must not see them (not tested how). LSP: not offered as a tool in 2.x (see tools row). | `grep -aoE 'OPENCODE_[A-Z0-9_]{3,}'` over the binary; `api-v2.json` `skills` |
| Isolated HOME (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, TEMP/TMP) | **works**: every file the server wrote (`opencode.db`, logs, cache, state, tmp) stayed under the step folder. Nothing appeared in the real `%APPDATA%`/`%LOCALAPPDATA%`. New: state is a SQLite database (`.local/share/opencode/opencode.db`, 50 migrations at boot). | `find` of the probe root after `start.mjs` |
| opencode.json **as Azhi writes it today** (1.x shape) | **changed**: 2.x loads it and translates it (`provider` → `providers[].settings`, `tool_call` → `capabilities.tools`, `mcp.<n>` with `timeout: 120000` → `mcp.servers.<n>.timeout {startup,catalog,execution}`, `enabled` → `disabled: false`, `tools`+`permission` → one `permissions` rule list, `bash` → `shell`, `task` → `subagent`). **But the result gives the model no tools at all**: MCP servers default to Code Mode (their tools hide behind an `execute` tool), and the translated `* → deny` denies `execute`. Unknown keys (such as `codemode`) are dropped from a 1.x-shaped file. So the current file must not be reused; write the 2.x shape. | `api-v1.json` `config` (translated document); `tools-all.json` `v1_current` → `[]`, `v1_current_nocode` → `[]` |
| opencode.json in the **2.x shape** | **changed**: `providers.anthropic.settings.{baseURL,apiKey}` + `models.<id>.{name,capabilities.tools,limit}`; `mcp.timeout.startup` and `mcp.servers.<n> = {type:'local', command, environment, codemode:false, timeout}`; `permissions: [{action:'*',resource:'*',effect:'deny'}, {action:'azhi_*',resource:'*',effect:'allow'}]`; `update:'disable'`; `share:'disabled'`. With this file the model is offered exactly `azhi_lookup` and `azhi_submit_output` and both calls complete. | `tools-all.json` `p_perm_nocode`, `p_perm2_nocode`; `session-v2.json` `modelCalls[].tools` |
| MCP tool names `azhi_<tool>` | **works** with `codemode: false`: the tools reach the model as `azhi_lookup` and `azhi_submit_output`, the same names as 1.x, so `azhi_*` rules and the bridge's `SUBMIT_TOOL` naming stay. With Code Mode on (the default) they are not offered by name. | `dump-false.json`; `tools-all.json` `p_open_code` vs `p_open_nocode` |
| `mcp` `timeout` (120 s to connect) | **changed**: now `{startup, catalog, execution}` per server or under `mcp.timeout`; `startup: 120000` accepted. | `api-v2.json` `config`; `@opencode/schema/dist/mcp.js` `TimeoutConfig` |
| `tools: { '*': false, … }` (ambient tools off) | **gone** as a key. Workaround: the `permissions` rule list (above). Built-in tools in 2.1.4 are `edit glob grep question read shell skill subagent webfetch websearch write execute`; `list`, `patch`, `apply_patch`, `multiedit`, `todowrite`, `todoread`, `codesearch`, `lsp` are not offered (`read` lists directories). `policies` (`tool.use`) did **not** remove built-in tools in the probe, so do not rely on it. | `dump-false.json`; `tools-all.json` `v2_policies*`, `p_policy_nocode` |
| `permission` deny (`edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`) | **changed**: now ordered `permissions` rules `{action, resource, effect}`; a later, more specific `allow` beats an earlier `* deny`. **`doom_loop` gives no protection in 2.x**: a model repeating a failing `submit_output` ran about 1,100 model calls in 40 s before the probe gave up (`s4error: timeout 40000`, event counts). Workaround, verified: the agent's `steps` (e.g. `steps: 3`) stops it: 3 model calls, then the tool call fails with "Tools are disabled after the maximum agent steps" and the turn ends. Keep the bridge's tool-call budget too. Write mode, verified: with `edit` and `write` allowed and `external_directory` denied, a write inside the checkout succeeds and `../outside.txt` and an absolute path outside are both refused ("Permission denied: external_directory"). The write tool's argument is `path`. | `session-v2.json` `eventTypes`, `s4error`; `gaps.json` `steps`; `gaps-write.json` |
| Agents (`agent/<name>.md`, `mode: primary`) | **works**: `agent/` and `agents/` markdown files are both loaded, and the agent's body leads the system prompt (`AGENT-PROMPT-MARKER` in every model call). JSON alternative: `agents.<name>.{system,description,mode,steps,permissions}`. Built-in agents are still `build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary` (listed capitalised). | `api-v2.json` `agents`; `session-v2.json` `systemHasAgentPrompt` |
| Commands (`command/<name>.md` with `agent`) | **works**: `command/` and `commands/` both load; `session.command({sessionID, name, text: ''})` runs the body after the queued input, with the agent's prompt. JSON alternative: `commands.<name>.{template,agent}`. | `api-v2.json` `commands`; `session-v2.json` `commandCalls` |
| Skills (`skill/<name>/SKILL.md`) | **works**: `skill/` and `skills/` both load. 2.x also always adds its bundled `opencode` and `report` skills, but with the `skill` tool denied neither appears in the prompt or the tool list. Leftover: the 2.x system prompt mentions `execute` / `tools.opencode.session_move` even when `execute` is denied (text only). | `api-v2.json` `skills`; `gaps.json` `skills` |
| Plugins (DCP via `plugin: [file URL]`) | **changed, works**: the key is now `plugins`. DCP 3.2.0 (the pinned version) ships its own OpenCode 2 implementation (`lib/v2`, on `@opencode/plugin`, entry `server.js`). 2.x refuses a file entry ("configured plugin path must be a directory"), so pass the **package folder** (file URL or path). Then the plugin is `active`, `compress` is offered, DCP reads `dcp.json` from `OPENCODE_CONFIG_DIR` as before, and a `compress` call over `@1@`–`@3@` removed both earlier tool outputs from the next request and put DCP's summary in their place. Allow `compress` in `permissions`. Risk carried over from 1.x: DCP also reads `.opencode/dcp.json` from the project and its parents, so a checked-out repository can change DCP's settings. | `dcp-v2.json` (file: refused), `dcp-v2-dir.json` (folder: active, `compress`), `dcp-run.json` (pruning); `dcp/lib/config.ts` |
| github-copilot provider | **changed**: built-in `github-copilot` integration (methods: env `GITHUB_TOKEN`, oauth `device` with github.com/enterprise). After `credential.create` it is active and lists models from OpenCode's catalog. Whether that list is filtered to what the **user's plan** enables (1.x behaviour the error message relies on) is **unverified**: only a fake token was used, so no real Copilot call was made. | `creds.json` `integrations`, `createCopilot`, `copilotModels` |
| ChatGPT-plan login plugin | **changed**: now built in, so no plugin is needed. `openai` integration has oauth methods `chatgpt-token-sharing`, `chatgpt-browser`, `chatgpt-headless` (the last two marked legacy). Azhi's sign-in is the device-code flow, so the method is `chatgpt-headless`. 2.x's own import of 1.x `auth.json` entries maps `accountId` → `metadata.accountID` and `enterpriseUrl` → `metadata.enterpriseUrl`, which gives the credential shape for both Copilot and ChatGPT. A real ChatGPT request was **not** tested. | `creds.json` `integrations`; binary: the `20260805200742_import_legacy_credentials` migration |
| Credentials in memory (`OPENCODE_AUTH_CONTENT`) | **gone**: the name is not in the binary, and a value set in the probe was ignored (no credential). A 1.x `auth.json` in the step's data folder was **not** imported either. Workaround: after the server starts and before the first prompt, `client.credential.create({ integrationID, label, value: {type:'oauth', methodID, refresh, access, expires}, activate: true })`. This works, but OpenCode stores the credential in the step's `opencode.db` (on disk, inside the step folder that is deleted afterwards), and in 1.x it stayed in env only. Anthropic keys can stay in `providers.anthropic.settings.apiKey`, and moving the whole config into `OPENCODE_CONFIG_CONTENT` would keep the key off disk. | `creds.json` `credentialsAtStart: []`, `credentialsAfter`; binary strings |
| ChatGPT sign-in renewal (`keepRenewedSignIn` reads the step's `auth.json`) | **changed**: renewed tokens live in the step's `opencode.db`, not in `auth.json`. Workaround: `client.credential.list()` before stopping the server (the entries carry `value`). Not exercised with a real renewal. | `@opencode/client` `credential.list` type: `CredentialEntry[]`, `Entry.value` in `schema/dist/credential.js` |
| MCP children not getting OpenCode's secrets | **works, and still needed**: MCP servers still receive `OPENCODE_SERVER_PASSWORD` in their environment (the probe server logged it), so keep the `env -u` / `azhi-mcp-launch.js` scrub. With `OPENCODE_AUTH_CONTENT` gone, the scrub list becomes `OPENCODE_SERVER_PASSWORD`, `OPENCODE_PASSWORD`, `OPENCODE_CONFIG_CONTENT`. | `api-v2.json` / `session-v2.json` `mcpLog.env` |
| `config.providers()` (is the model offered?) | **changed**: `provider.list({location})` returns providers (no models); `model.list({location})` returns `{id, providerID, enabled, cost[]}`. A custom model from the config is listed and `enabled: true`. `session.create` accepts an unknown model without error, so the check before the session stays necessary. | `api-v1.json` `models` (`probe-model`); `session-v2.json` `unknownModelCreate: "accepted"` |
| `mcp.status()` (wait for the bridge) | **changed**: `mcp.list({location})` → `{data: [{name, status: {status: 'connected'\|'pending'\|'failed'\|'disabled'…}}]}`. **The list starts empty**, so the wait must look for each named server (an empty list passes an `every` check: two probe runs raced the MCP startup this way and the model got no bridge tools). | `api-v2.json` `mcp`; `dump-false.json` before and after the fix |
| `session.create({title})` + `directory` on the client | **changed**: the client has no `directory` option; it goes on each call as `location: {directory}`. `session.create({title, agent, model: {id, providerID}, location})` sets the agent and model once for the session. | `@opencode/client/dist/promise/generated/types.d.ts` `SessionCreateInput` (`id parentID title agent model location metadata permissions`); `session-v2.json` `session` |
| `session.prompt({model, agent, system, parts})` blocking until the turn ends | **changed**: `session.prompt({sessionID, text, files?, agents?, skills?, delivery?, resume?})` has no `model`, `agent`, `system` or `parts`; it **returns at once** (10 ms) with the queued inbox item. Wait with `session.wait({sessionID})` (`/api/experimental/session/:id/wait`, marked experimental), then read messages. Model and agent come from the session (`switchModel` / `switchAgent` to change). The system prompt has no per-prompt override: use the agent's prompt (`agents.<n>.system` or `agent/<n>.md`) for the no-profile path too; `session.instructions.entry.put` exists but is experimental and was not tried. | `SessionPromptInput` members; `session-v2.json` `promptReturnedAfterMs`, `waitMs` |
| `session.prompt({noReply: true})` (untrusted input as its own message) | **changed**: `session.prompt({..., resume: false})` queues the message without a model call (0 calls after 2.5 s), and the following `session.command` delivers it first, as a plain user message. The text `$(echo hi) !\`echo hi\`` was passed through unexpanded. | `session-v2.json` `resumeFalseModelCalls: 0`, `commandCalls[0]` |
| `session.command({command, arguments, agent, model})` | **changed**: `session.command({sessionID, name, text, files?, agents?, skills?, delivery?})` returns `void` at once; wait with `session.wait`. No `agent`/`model` arguments: they come from the command file and the session. | `SessionCommandInput` members; `session-v2.json` `commandCalls` |
| `session.abort({sessionID})` | **changed**: `session.interrupt({sessionID})` → `{interrupted: true}`; `session.wait` then returns in about 50 ms, and the last assistant message has `finish: 'error', error: {type: 'aborted', message: 'Step interrupted'}`. | `session-v2.json` `interrupt`, `interruptWaitMs`, `s3messages` |
| `session.messages({sessionID})` → `{info, parts}[]` | **changed**: `message.list({sessionID, order, limit, cursor, type})` → `{data: SessionMessageInfo[], cursor}`, **paginated**. Messages are typed (`user`, `assistant`, `idle`, `synthetic`, `compaction`, `shell`, …). An assistant message carries `content[]` (`text` / `reasoning` / `tool` with `state.{status,input,content,error}`) instead of separate parts. | `SessionMessagesResponse`, `SessionMessageAssistant` types; `session-v2.json` `messages`, `messagesCursor` |
| Event stream: `message.updated`, `message.part.updated`, `message.part.delta`, `session.error` | **gone**: none are emitted. Workaround: the new `session.*` events: `session.text.started/delta/ended`, `session.reasoning.*`, `session.tool.input.started/ended`, `session.tool.called`, `session.tool.success`/`failed`, `session.step.started/ended/failed`, `session.execution.started/succeeded/failed/interrupted`, `session.retry.scheduled`, `session.compaction.*`, `session.usage.updated`. Payload is `{type, data: {sessionID, assistantMessageID, …}}` (not `properties`). `event.subscribe({signal})` is an async iterable with no `sseMaxRetryAttempts`. | `V2Event` union in `types.d.ts`; `session-v2.json` `eventTypes`, `sampleEvents` |
| Tokens on assistant messages (`tokens.{input,output,reasoning,cache.read,cache.write}`) | **works**: same field names, on each assistant message and on `session.step.ended`. The probe's 3 model calls report 100 in / 20 out each, matching the fake. The session itself also carries `cost` and `tokens`. | `TokenUsageInfo`; `session-v2.json` `messages[].tokens` |
| Cost on assistant messages (`cost`) | **works**: `cost` (USD number). For a model with no rates in the catalog (`cost: []`, as with the fake), it is `0`, not absent, so `reported_cost` would say `0` where the rule is "unavailable". Same as 1.x for that case; treat `cost: []` as `null`. | `session-v2.json` `messages[].cost: 0`, `modelOffered[].cost: []` |
| Usage of title generation | **changed, risk**: 2.x makes an extra "Reply with only the title" call per session on the session's model (`commandCalls[1]`). It is reported as `session.usage.recorded` with `source: 'title'`, not as an assistant message, so summing assistant messages under-counts usage, and `test/opencode.test.ts`'s `100 * calls.length` check would fail. Fix, verified: `agents.title.disabled: true` removes the title call (1 extra call → 0). | `session-v2.json` `commandCalls`; `gaps.json` `title` |
| Error reference in logs (`ref=` lookup in `describe`) | **unverified**: no internal error happened in the probes; v2 logs are `key=value` lines, and errors on messages are `{type, message, status?, response.body?}`. | `SessionStructuredError` type |
| Process stop (`killTree` SIGTERM/SIGKILL) | **works**: `killTree` (taskkill /T) on a 2.x server stopped it and both of its child processes (the MCP bridge and its helper). | `gaps.json` `kill`; `tasklist /FI "IMAGENAME eq opencode.exe"` |

## Implementation status (2026-10-25)

Built behind `AZHI_OPENCODE_MAJOR=2` (default stays 1.18.34): `src/worker/harness-opencode2.ts`,
`src/worker/opencode2-transcript.ts`, the dispatch in `harness-activity.ts`, version parsing and the major in
`capabilities.ts`, `opencode2Binary` / `installOpencode2` and DCP's package folder in `tools.ts`,
`azhi setup --opencode2`, `@opencode/client` 2.1.4 as a dependency, `OPENCODE_PASSWORD` in `OPENCODE_PRIVATE_ENV`,
`docs/install.md`.

Verified on Windows 11 against Temporal and PGlite, with the fake Anthropic endpoint:

| Run | 1.18.34 | 2.1.4 |
| --- | --- | --- |
| `test/opencode.test.ts` (plan, gateway, repair, profile harness, cancel) | 5/5 | 5/5, repeated 6× for the gateway case |
| same, with DCP 3.2.0 in the tools folder (profile step offered `compress`) | 5/5 | 5/5 |
| `test/opencode2.test.ts` (version parse, binary lookup, DCP folder) | n/a | 3/3 |

Departures from the steps below, and why:
- **The 2.x CLI is not an npm dependency.** `azhi setup --opencode2` installs it into the tools folder (scripts
  off; the platform package's binary is used, the AVX2 build before baseline), as DCP is installed. That way
  nobody downloads another 250 MB until they opt in.
- **The config stays a file** (`OPENCODE_CONFIG`), as in 1.x and every probe; `OPENCODE_CONFIG_CONTENT` was only
  shown to load a trivial key.
- **A 500 ms wait after the MCP servers report `connected`.** New finding from the adapter run: in 2.1.4 a prompt
  sent right after `connected` was offered no MCP tools in 10 of 12 tries (`tools/list` had already run; no
  event marks the moment the tools reach sessions), and one sent 100 ms or more later in 0 of 20 (`race.mts`).
  If a turn still misses them, the submit reminder recovers. Worth reporting upstream.
- **`steps` = max tool calls + repairs + 2 per turn**, merged into a profile's markdown agent (checked:
  `agent.get` shows the markdown body, its description and `steps` from JSON, `merge.mjs`).
- **Write mode allows `edit` and `write` only.** 2.x has no `patch`, `apply_patch` or `multiedit`.

Found on the way (not OpenCode 2 issues, not fixed here except the first):
- `test/opencode.test.ts` switched the fixture step to OpenCode with an LF-only string replace. On a Windows
  checkout (`core.autocrlf`, CRLF) it matched nothing, so the "OpenCode conformance" suite silently ran the
  model-agent. Fixed: CRLF-tolerant, and it throws if the switch does not happen. `test/harness-executors.test.ts`
  has the same bug for claude-agent-sdk.
- On this machine SWC's native addon refuses `%LOCALAPPDATA%\swc` (its ACL grants an AppContainer SID), so
  Temporal's workflow bundling fails. `SWC_NATIVE_BINDING_CACHE` pointed at a folder with a clean ACL works around it.
- `test/ai-sdlc-e2e.test.ts` runs `execFile('npx', …)` (fails on Windows: `npx` is a `.cmd`), and the AI-SDLC and
  SDLC-implement suites need Linux memory limits and a GitHub clone, so the profile and write-mode e2e suites
  cannot run on native Windows. Write-mode scoping was verified at the OpenCode level instead (`gaps-write.json`).
- `test/token-saving.test.ts` hard-codes `:` as the PATH separator (fails on Windows).
- DCP reads `.opencode/dcp.json` from the checked-out repository and its parents (1.x and 2.x alike), so a
  repository can change DCP's settings for a step.

## Code changes needed

1. **Dependencies** (`package.json`): add `@opencode/client` and `@opencode/cli` pinned at `2.1.4` (`@opencode/cli`'s
   postinstall puts the platform binary at `bin/opencode.exe`; check that it still runs under the repo's npm
   `allow-scripts` setting). Keep `opencode-ai` / `@opencode-ai/sdk` 1.18.34 while both run side by side.
   Update the `Dockerfile` line that strips `opencode-ai` / `opencode-linux-*`.
2. **`src/worker/capabilities.ts`**: `opencodeBinary()` takes a major (or a second function): `AZHI_OPENCODE2_BIN`, then
   `node_modules/@opencode/cli/bin/opencode.exe`, then `opencode2` on PATH. Parse `opencode v2.1.4` to `2.1.4`.
   Advertise `runtimes.opencode2` (or `opencode.major`) so the planner can tell them apart.
3. **New `src/worker/harness-opencode2.ts`** (keep `harness-activity.ts` as the 1.x path rather than branching every
   call), sharing the workspace, bridge-state, test-loop and finish logic. It writes:
   - the 2.x config: `providers`, `mcp.servers.*` with `codemode: false` and `timeout`, `permissions` rules
     (`* deny`, `azhi_*` allow, profile read tools allow, write-mode `edit`/`write` allow), `update: 'disable'`,
     `share: 'disabled'`, `agents.<step>.steps` as a hard stop, and the title agent disabled;
   - preferably through `OPENCODE_CONFIG_CONTENT` (in memory) instead of a file, so the Anthropic key stays off disk;
   - Copilot / ChatGPT sign-in via `client.credential.create` after start (and `credential.list` before stop for the
     renewal), replacing `OPENCODE_AUTH_CONTENT` and `keepRenewedSignIn`'s `auth.json` read.
   The turn loop becomes `session.create({agent, model, location})` → `session.prompt({text, resume:false})` for
   the input when there is a command → `session.command({name, text:''})` or `session.prompt({text})` →
   `session.wait` → read the bridge state. Cancel and the bridge's stop watcher call `session.interrupt`.
   `waitForBridge` uses `mcp.list` and waits for each named server. The model check uses `model.list`.
4. **`src/worker/opencode-setup.ts`**: the files it writes (`agent/`, `command/`, `skill/`) load as is. Add the 2.x
   tool-name map for profile `tools` (`OPENCODE_READ_TOOLS`: `read grep glob skill` all still exist; `list` is gone)
   and put the profile's MCP servers under `mcp.servers` with `codemode: false`. The no-profile path also needs an
   agent file now, because `prompt` has no `system`.
5. **New `src/worker/opencode2-transcript.ts`**: map the `session.*` events and the typed messages (`content[]`) to
   transcript entries; backfill with `message.list` and follow `cursor.next` until it is null.
6. **Usage** (`finish`): sum `assistant` messages' `tokens`; add `session.usage.recorded` (title, compaction) or turn
   title generation off; `reported_cost` is `null` when the model has no rates.
7. **`OPENCODE_PRIVATE_ENV`**: add `OPENCODE_PASSWORD` and `OPENCODE_CONFIG_CONTENT`.
8. **Capabilities / docs**: `src/executors/capabilities.ts` version entry, `src/agents/profile.ts` "verified against"
   note, `src/api/copilot.ts` `OPENCODE_USER_AGENT`, `docs/windows-local-setup.md`. The `azhi copilot` commands
   that read `~/.local/share/opencode/auth.json` (`src/cli/main.ts`) need `opencode auth export` (prints stored
   credentials as JSON) for machines on 2.x.
9. **Tests**: run `test/opencode.test.ts` against both majors (parameterised on the binary); `test/opencode-windows.test.ts`
   pins `node_modules/opencode-ai/bin/opencode.exe` and `OPENCODE_AUTH_CONTENT`; add cases for the empty-MCP-list
   race and the `steps` stop.

## Risks

- **Silent loss of the gateway tools.** Any 1.x-shaped config, Code Mode left on, or a bridge-readiness wait that
  passes on an empty list gives the model no Azhi tools, and the step only fails as "did not call submit_output".
  The conformance test must assert the exact offered tool list (it already does) on 2.x.
- **No doom-loop guard.** 2.x kept calling a failing tool about 1,100 times in 40 s. It needs `steps` plus the
  bridge budget; without them a looping model burns the provider budget fast.
- **Experimental endpoints.** `session.wait` and `session.instructions.*` are under `/api/experimental/`. If `wait`
  changes, fall back to watching for `session.execution.succeeded`/`failed`/`interrupted` events.
- **Secrets on disk.** Provider credentials are stored in the step's SQLite file (not env). It is inside the step
  folder, which is deleted, but a crash leaves it behind.
- **Wider default surface.** 2.x adds bundled skills, `subagent`, `execute` (Code Mode with `fetch`), `websearch`,
  a filesystem watcher on the config folder, and system or managed-preference config sources (seen in the binary,
  not probed). All of these must be denied or confirmed absent per step.
- **Copilot plan model list and the ChatGPT flow** were not tested with real accounts.
- **Binary size and install:** 247 MB per platform package, behind a postinstall script.
- **Moving target:** 2.x was first published 2026-09-02 and is at 2.1.4. 1.x is still released (1.19.4 on
  2026-10-22) and offers `opencode upgrade --major`, so 1.x is not end-of-life yet.

## Side by side?

Yes. Run 1.x and 2.x side by side behind a worker setting, `AZHI_OPENCODE_MAJOR=1|2` (default `1`), plus a
separate binary override (`AZHI_OPENCODE2_BIN`). The config shape, credential path, event model and turn loop all
differ, so a new adapter file is cleaner than branches inside `harness-activity.ts`. Report the major in
`harness.version` (`opencode@2.1.4`) so run history shows which one ran. Flip the default only after the
conformance suite and one real Anthropic, Copilot and ChatGPT run each pass on 2.x on Windows and Linux.

## Recommendation

Migrate, but not as a drop-in, and not yet as the default. Use `@opencode/client` against a per-step
`opencode serve`, not the in-process `@opencode/sdk`. The probes show the isolation model holds on 2.1.4
(private server, password, isolated HOME, config folder, MCP bridge with `azhi_*` names, tokens). The adapter
needs a rewrite of the config writer, the turn loop (queued prompt + `wait`), the transcript (new events) and the
credential path. Plan it as one feature behind `AZHI_OPENCODE_MAJOR=2`, keeping 1.18.34 as the default until 2.x
passes the same conformance suite.

**Update (2026-10-25):** done behind the setting, and 2.x passes the same conformance suite as 1.x (see
Implementation status). Before making 2.x the default: one real Anthropic, Copilot and ChatGPT run each on 2.x, a
Linux worker run, and the e2e suites on Linux.

**Verified after the first draft (2026-10-25):** DCP 3.2.0 on 2.x (loads from its package folder, and pruning works), `steps` stopping a
loop, write-mode scoping, disabling the title call, bundled skills staying out of the prompt, and `killTree`. Probes `dcp.mjs`,
`dcp-run.mts` and `gaps.mts` are in the notes folder.

**Still unverified:** Copilot model list per plan and a real Copilot call; a real ChatGPT request and token renewal; error-reference lookup in logs;
Linux and macOS; behaviour after the next 2.x release.
