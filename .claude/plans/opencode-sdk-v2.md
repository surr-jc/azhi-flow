# Feature: Move the OpenCode adapter to the OpenCode v2 SDK client

The following plan should be complete, but validate documentation and codebase patterns and task sanity
before you start implementing. Pay special attention to the exact v2 method signatures quoted below: v2
flattens every request into one object, so a missed call site still type-checks only if it is cast.

## Feature Description

Azhi's OpenCode harness (`src/worker/harness-activity.ts`, `src/worker/opencode-transcript.ts`) drives a
headless `opencode serve` through `@opencode-ai/sdk`'s **v1** client (`import ... from '@opencode-ai/sdk'`).
The same npm package already ships a **v2** client at the `@opencode-ai/sdk/v2` subpath (present in the
pinned 1.18.34 and in the latest 1.19.4). v2 is the generated client OpenCode maintains going forward: flat
parameters, `sessionID` naming, `message.part.delta` streaming events, typed `directory`/`workspace` on every
call. This change moves every call site to v2 without changing behaviour, then (optionally, separate commit)
bumps the pinned pair `@opencode-ai/sdk` + `opencode-ai` together.

## User Story

As an Azhi maintainer
I want the OpenCode adapter on the v2 SDK client
So that we stay on OpenCode's supported API, get correct live text streaming, and can take future OpenCode
releases without a forced rewrite.

## Problem Statement

- The v1 client is the legacy surface; new endpoints and types land in v2 only.
- The current code casts around the v1 types (`as Parameters<typeof createOpencodeClient>[0]`,
  `subscribe({ signal, sseMaxRetryAttempts } as never)`, `as Array<...>` on messages), which hides drift.
- OpenCode servers that stream text as `message.part.delta` events (v2 event, `partID`/`field`/`delta`) are
  not handled by `OpencodeTranscript.onEvent`; live text then only appears on `backfill` at step end.

## Solution Statement

Swap imports to `@opencode-ai/sdk/v2`, rewrite the seven call shapes to v2's flat parameter objects, pass
the SSE `signal` through the second `options` argument, handle `message.part.delta` in the transcript, and
drop casts the v2 types make unnecessary. Keep the server binary and SDK at the same version (1.18.34) in
the first commit so the SDK swap is isolated from any server behaviour change; a version bump is a second,
separately validated commit.

## Feature Metadata

**Feature Type**: Refactor (plus a small transcript fix)
**Estimated Complexity**: Low–Medium (≈2 source files, ~15 call sites; risk is in runtime shape, not volume)
**Primary Systems Affected**: `src/worker` OpenCode harness and transcript
**Dependencies**: `@opencode-ai/sdk` (v2 subpath, already installed), `opencode-ai` binary (unchanged in commit 1)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ BEFORE IMPLEMENTING

- `src/worker/harness-activity.ts`
  - line 3 — `import { createOpencodeClient } from '@opencode-ai/sdk';`
  - lines 299–308 — `step()` wrapper (error reporting, one retry on ECONNRESET for idempotent reads). Keep as is.
  - lines 310–314 — client creation with `baseUrl`, `directory`, Basic auth header, and a cast.
  - line 319 + lines 492–504 — `waitForBridge` → `client.mcp.status()`.
  - line 321 — `client.config.providers()` → `.data?.providers.find(...)`, `.models[input.model]`.
  - line 331 — `client.session.create({ body: { title } })`.
  - lines 333, 357 — `client.session.abort({ path: { id } })`.
  - lines 349–351 — `client.session.prompt({ path, body: { noReply: true, model, agent, parts } })`.
  - lines 362–368 — `client.session.command({ path, body: { command, arguments: '', agent, model: 'provider/model' } })`
    and `client.session.prompt({ path, body: { model, agent | system, parts } })`.
  - line 372 — `r.error ?? r.data?.info.error` (works for both prompt and command results).
  - lines 416–418 — `finish()` → `client.session.messages({ path: { id } })` with a hand-written cast.
- `src/worker/opencode-transcript.ts`
  - line 1, 5 — v1 client type import.
  - line 30 — `event.subscribe({ signal, sseMaxRetryAttempts: 3 } as never)`.
  - lines 57–64 — `onEvent`: handles `message.updated`, `message.part.updated` (with v1 `properties.delta`), `session.error`.
  - lines 77–84 — `onPart` merges a streamed delta into the stored part text.
- `test/opencode.test.ts` — conformance suite; runs the real pinned binary against `src/testing/fake-anthropic.ts`.
  Skips when Temporal is unavailable or no OpenCode binary (`opencodeBinary()` in `src/worker/capabilities.ts:76`).
- `test/opencode-windows.test.ts` — Windows spawn/binary resolution; must stay green.
- `test/pr-review.test.ts`, `test/workspace-write.test.ts` — also run the OpenCode harness end to end.
- `src/worker/opencode-setup.ts` — profile `.opencode/` setup (agent, command). No SDK use; no change.
- `spikes/06-opencode.ts` — historic spike; does not import the SDK. Leave alone.

Version pins that must move together **only in the optional bump commit** (Task 8):
`package.json:30,51`, `src/executors/capabilities.ts:44-47`, `src/api/copilot.ts:21` (`OPENCODE_USER_AGENT`),
comments in `src/agents/profile.ts:66`, `src/worker/opencode-setup.ts:13`, `src/builder/models.ts:51`,
`src/agents/copilot-pricing.ts:27`, and `docs/phase-3.md:32`. Historic result docs
(`docs/phase-0-results.md`, `docs/pr-review.md`, `docs/runbooks/...`) record what was measured — do not rewrite them.

### New Files to Create

- None required. Optional: `test/opencode-transcript.test.ts` — unit test for `OpencodeTranscript.onEvent`
  with fake v2 events (no binary, no Temporal), so the delta handling is covered on every machine.

### Relevant Documentation

- Installed v2 typings (authoritative for the pinned version):
  `node_modules/@opencode-ai/sdk/dist/v2/client.d.ts`, `dist/v2/gen/sdk.gen.d.ts`
  (`class Session2` ≈ line 952, `Config2` 337, `Mcp` 648, `Event` 326), `dist/v2/gen/types.gen.d.ts`
  (`EventMessagePartDelta` ≈ 5712, `AssistantMessage` ≈ 210, `Part` 474).
- OpenCode SDK docs: https://opencode.ai/docs/sdk/ — client creation and session methods.
- npm: `@opencode-ai/sdk` latest is 1.19.4 (checked 2026-10-25); `opencode-ai` must be the same version.

### v1 → v2 call mapping (verified against the installed 1.18.34 typings)

| Call | v1 (today) | v2 |
|---|---|---|
| import | `from '@opencode-ai/sdk'` | `from '@opencode-ai/sdk/v2'` (types: `import type { OpencodeClient } from '@opencode-ai/sdk/v2'`) |
| create client | `createOpencodeClient({ baseUrl, directory, headers } as ...)` | same keys, **no cast**: v2 `createOpencodeClient(config?: Config & { directory?: string })` |
| MCP status | `client.mcp.status()` | `client.mcp.status()` (unchanged) |
| providers | `client.config.providers()` | `client.config.providers()` (unchanged; same `{ providers, default }` data) |
| create session | `session.create({ body: { title } })` | `session.create({ title })` |
| abort | `session.abort({ path: { id } })` | `session.abort({ sessionID: id })` |
| prompt | `session.prompt({ path: { id }, body: { model: { providerID, modelID }, agent, system, noReply, parts } })` | `session.prompt({ sessionID: id, model: { providerID, modelID }, agent, system, noReply, parts })` |
| command | `session.command({ path: { id }, body: { command, arguments, agent, model: 'p/m' } })` | `session.command({ sessionID: id, command, arguments, agent, model: 'p/m' })` |
| messages | `session.messages({ path: { id } })` | `session.messages({ sessionID: id })` (has optional `limit`/`before`; omit both = all) |
| events | `event.subscribe({ signal, sseMaxRetryAttempts } as never)` | `event.subscribe(undefined, { signal, sseMaxRetryAttempts: 3 })` — options are the **second** argument |
| streamed text | `message.part.updated` with `properties.delta` | `message.part.delta` `{ sessionID, messageID, partID, field, delta }`; `message.part.updated` no longer has `delta` |

Note the asymmetry: `session.create`'s `model` is `{ id, providerID }` while `prompt`'s is `{ providerID, modelID }`.
We do not pass `model` to `create`, so this does not bite unless someone adds it.

### Patterns to Follow

- Every server call stays inside `step(name, f, idempotent)` (harness-activity.ts:299). Reads
  (`bridge`, `providers`, `messages`) pass `idempotent = true`; writes (`session`, `input`, `prompt`) do not.
- Errors are `ApplicationFailure.create({ type: ErrorClass.*, message })`; keep messages prefixed `opencode <step>:`.
- Results are `{ data, error }` (no `throwOnError`); keep checking `.error` / `.data` exactly as today.
- Comment density: one short sentence above non-obvious lines, as in the surrounding code. No new JSDoc blocks.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation
Confirm the v2 subpath resolves under the project's TS module settings (`moduleResolution` must honour `exports`).

### Phase 2: Core Implementation
Rewrite call shapes in `harness-activity.ts`; switch the transcript's client type, SSE options and delta handling.

### Phase 3: Integration
No registration changes: the harness is the only consumer. Remove now-unneeded casts.

### Phase 4: Testing & Validation
Typecheck, unit-test the transcript, run the OpenCode conformance suite against the real pinned binary.

---

## STEP-BY-STEP TASKS

### 1. VERIFY v2 subpath resolution

- **IMPLEMENT**: Nothing yet; check `tsconfig.json` `module`/`moduleResolution` is `NodeNext`/`Bundler` (needed for `exports` subpaths).
- **VALIDATE**: `node -e "import('@opencode-ai/sdk/v2').then(m=>console.log(typeof m.createOpencodeClient))"` prints `function`.

### 2. UPDATE `src/worker/opencode-transcript.ts` — client type and SSE options

- **IMPLEMENT**:
  - `import type { OpencodeClient } from '@opencode-ai/sdk/v2';` and `type Client = OpencodeClient;`
  - line 30: `await this.client.event.subscribe(undefined, { signal: this.abort.signal, sseMaxRetryAttempts: 3 })` — drop `as never`.
  - Keep `sub.stream` iteration; keep the local `AnyPart`/`AnyMessage` loose types (the transcript intentionally reads optional fields across part kinds).
- **GOTCHA**: In v1 the signal sat in the first argument and was silently accepted by the cast; in v2 the first argument is query params (`directory`, `workspace`). Putting `signal` there would be sent as nothing and the stream would never stop on `stop()`.
- **VALIDATE**: `npm run typecheck`

### 3. ADD `message.part.delta` handling in `OpencodeTranscript`

- **IMPLEMENT** in `onEvent`:
  ```ts
  else if (ev.type === 'message.part.delta') this.onDelta(ev.properties);
  ```
  and a small `onDelta({ sessionID, partID, field, delta })`: ignore other sessions; if a part with `partID` is
  known and `field === 'text'`, set `text = (prev.text ?? '') + delta` and `emit`; if not yet known, keep the
  delta in a pending map keyed by `partID` and prepend it when `onPart` first sees that part.
- **KEEP** the existing `delta` argument path in `onPart` (older servers, and `backfill` passes none).
- **GOTCHA**: `message.part.updated` in v2 carries the full part; when it arrives after deltas, its `text` replaces the accumulated text — that is correct (it is authoritative). Don't double-append.
- **VALIDATE**: `npx vitest run test/opencode-transcript.test.ts` (Task 7)

### 4. UPDATE `src/worker/harness-activity.ts` — import and client creation

- **IMPLEMENT**:
  - line 3: `import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';`
  - lines 310–314: same object, remove `as Parameters<typeof createOpencodeClient>[0]`.
  - lines 416 and 492: parameter type `ReturnType<typeof createOpencodeClient>` → `OpencodeClient`.
- **GOTCHA**: v2's client already sets `x-opencode-directory` from `directory`; do not also pass `directory` per call.
- **VALIDATE**: `npm run typecheck` (will fail until Task 5 — do 4 and 5 together).

### 5. UPDATE `src/worker/harness-activity.ts` — session call shapes

- **IMPLEMENT** (exact replacements, per the mapping table):
  - 331: `client.session.create({ title: \`${input.runId}/${input.nodeId}\` })`
  - 333, 357: `client.session.abort({ sessionID: session.id })`
  - 350: `client.session.prompt({ sessionID: session.id, noReply: true, model: { providerID, modelID: input.model }, agent: setup.agent, parts: [{ type: 'text', text }] })`
  - 364: `client.session.command({ sessionID: session.id, command: setup.command, arguments: '', agent: setup.agent, model: \`${providerID}/${input.model}\` })`
  - 365–368: `client.session.prompt({ sessionID: session.id, model: { providerID, modelID: input.model }, ...(setup ? { agent: setup.agent } : { system }), parts: [{ type: 'text', text }] })`
  - 418: `client.session.messages({ sessionID })`; replace the hand-written cast with the SDK's
    `Array<{ info: Message; parts: Part[] }>` narrowed by `m.info.role === 'assistant'` (import `type AssistantMessage`),
    so `tokens`/`cost` are typed. Keep the `null` result when there are no assistant messages (CLAUDE.md: unknown is null).
- **GOTCHA**: `arguments: ''` must stay — the input never goes in as a command argument (untrusted text; see comment at 345–347). Do not "simplify" by passing `text` as `arguments`.
- **GOTCHA**: line 372 `r.data?.info.error` — both v2 `prompt` and `command` return `{ info: AssistantMessage, parts }`; confirm with typecheck, no cast.
- **VALIDATE**: `npm run typecheck`

### 6. REMOVE leftover v1 references

- **VALIDATE**: `git grep -n "from '@opencode-ai/sdk'" -- src test` returns nothing (only `/v2` imports remain).

### 7. CREATE `test/opencode-transcript.test.ts` (unit, no binary)

- **IMPLEMENT**: Construct `OpencodeTranscript` with a stub client (`{ event: { subscribe: async () => ({ stream: gen() }) } }`)
  and a sink stub collecting `put` entries (mirror the sink shape in `src/worker/transcript.ts`). Cases:
  1. `message.updated` (assistant) → `message.part.delta` ×2 → entry text is the concatenation.
  2. delta arriving before its `message.part.updated` → text not lost.
  3. `message.part.updated` with full text after deltas → text equals the full text, not doubled.
  4. events for another `sessionID` are ignored.
  5. v1-style `message.part.updated` with `properties.delta` still works.
- **PATTERN**: plain vitest `describe/it/expect` like `test/opencode-windows.test.ts`.
- **VALIDATE**: `npx vitest run test/opencode-transcript.test.ts`

### 8. (Optional, separate commit) BUMP OpenCode 1.18.34 → 1.19.4

Only after Tasks 1–7 pass on 1.18.34.
- **UPDATE** `package.json` both `@opencode-ai/sdk` and `opencode-ai` to the same exact version; `npm install`.
- **UPDATE** `src/executors/capabilities.ts:47` version, `src/api/copilot.ts:21` user agent, and the
  "verified against" comments listed in Context References — **only after re-verifying each claim** (built-in
  tool names in `profile.ts:66`, the tools/permissions lock in `opencode-setup.ts:13`, the ChatGPT model list in
  `builder/models.ts:51`, Copilot rates in `copilot-pricing.ts:27`). If a claim can't be re-verified, leave the
  old version in that comment rather than guessing.
- **UPDATE** `docs/phase-3.md:32`. Leave historic result docs untouched.
- **GOTCHA**: the server can change event and config behaviour between minors; rerun the full conformance and PR-review suites, and the Windows test.
- **VALIDATE**: `npx vitest run test/opencode.test.ts test/opencode-windows.test.ts test/pr-review.test.ts test/workspace-write.test.ts`

---

## TESTING STRATEGY

### Unit Tests
`test/opencode-transcript.test.ts` (new) covers event handling without OpenCode or Temporal.

### Integration Tests
`test/opencode.test.ts` is the adapter conformance suite (real binary + fake Anthropic endpoint): it already
asserts gateway-only tools, validated output, usage sums (`input_tokens: 100 * calls`), repair feedback and
cancellation — exactly the paths the call-shape change touches. `pr-review` and `workspace-write` cover the
profile command path (`session.command` + `noReply` input) and write-mode.

### Edge Cases
- Cancellation: `session.abort({ sessionID })` reaches the server (conformance "cancels a running harness").
- Bridge stop watcher (line 357) aborts mid-turn.
- Profile with `setup.command`: input sent with `noReply` first, then the command with `arguments: ''`.
- No assistant messages → usage fields `null`, `reported_cost: null`.
- SSE stream stops on `transcript.stop()` (no hanging process after the step; the `finally` must complete).
- First call meeting a stale keep-alive connection still retries once (`step(..., true)`).

### E2E / Browser Automation
Not applicable: no UI change. The Run page renders the same transcript entries; optionally open a run in
`npm run demo` and confirm the agent's text appears live in the activity panel rather than only at the end.

---

## VALIDATION COMMANDS

### Level 1: Types
```bash
npm run typecheck
```

### Level 2: Unit
```bash
npx vitest run test/opencode-transcript.test.ts test/opencode-windows.test.ts
```

### Level 3: Integration (needs Temporal dev server + pinned OpenCode binary; skips otherwise — report a skip as a skip)
```bash
npx vitest run test/opencode.test.ts test/pr-review.test.ts test/workspace-write.test.ts
```

### Level 4: Full suite
```bash
npm run test:local
```

### Level 5: Manual
Run an OpenCode-executor workflow (`npm run demo` or `npm run azhi -- run ...` on `examples/ci-digest`) and
check: step succeeds, usage/cost recorded, transcript shows streamed assistant text, cancel stops the
`opencode` process (no orphan in Task Manager on Windows).

---

## ACCEPTANCE CRITERIA

- [ ] No import of `'@opencode-ai/sdk'` (v1 root) remains in `src/` or `test/`; all use `'@opencode-ai/sdk/v2'`.
- [ ] The casts at harness-activity.ts:314, :418 and opencode-transcript.ts:30 are gone; `npm run typecheck` passes.
- [ ] `message.part.delta` events produce live transcript text; v1-style deltas still work.
- [ ] `test/opencode.test.ts` passes on the real pinned binary (or is reported as skipped, with the reason).
- [ ] Usage, cost and model-call counts are unchanged for the conformance script.
- [ ] Untrusted input is still never a command argument (`arguments: ''`).
- [ ] Commit 1 changes no version pins; any bump is its own `chore:`/`feat:` commit with re-verified comments.

## COMPLETION CHECKLIST

- [ ] Tasks 1–7 done in order, each validation run
- [ ] Levels 1–4 pass (integration skips stated explicitly)
- [ ] Manual run confirms streaming and cancellation
- [ ] Conventional commit(s) on `dev`: `refactor: move the OpenCode adapter to the v2 SDK client`

## NOTES

- **Why no version bump in the same commit**: the v2 client is already in the pinned 1.18.34 package, so the
  swap can be validated against an unchanged server. Mixing it with a server upgrade would make a failing
  conformance run ambiguous.
- **Why keep `AnyPart`/`AnyMessage` in the transcript**: it reads optional fields across a dozen part kinds;
  switching to the SDK's discriminated `Part` union is possible but is an unrelated refactor.
- **Not in scope**: v2's `client.v2.*` experimental namespace, `workspace`/`experimental_workspaceID`, the
  Claude Agent SDK and Codex harnesses.
