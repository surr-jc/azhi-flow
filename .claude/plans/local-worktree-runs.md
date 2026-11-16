# Feature: Local worktree runs with "Open in VS Code"

The following plan should be complete, but validate documentation, codebase patterns and task sanity before you start implementing.

Pay special attention to the names of existing utils, types and models. Import from the right files.

**Do not touch the uncommitted triggers work on `dev`** (`src/api/triggers.ts`, `src/cel/trigger.ts`, `src/server/triggers.ts`, `migrations/0014_triggers.sql`, `docs/triggers.md`, `test/triggers.test.ts`, and the modified `README.md`, `docs/positioning.md`, `src/api/app.ts`, `src/cli/main.ts`, `src/compiler/compile.ts`, `src/db/schema.ts`, `src/definition/schema.ts`, `src/definition/types.ts`, `src/runtime/types.ts`, `src/server/workflows.ts`, `web/src/api.ts`, `web/src/pages/Run.tsx`, `web/src/pages/Schedules.tsx`). Several of those files are edited by this plan too: add to them, never revert or reformat what is there. Ask the user to commit the triggers work first if a clean diff matters.

## Feature Description

An agent step's workspace may be a **local git folder** on the worker's machine instead of a fresh clone of a remote repository. The run gets its own **git worktree** of that folder on a run branch (`azhi/<runId>`). Every step of the run that names the folder works in that same worktree, and the worktree stays after the step and after the run. The Run page shows where it is and offers **Open in VS Code**.

This is the `workspace: local` item of `docs/desktop-app-plan.md` Phase 3, settling its open question in favour of a worktree.

## User Story

As a developer running Azhi on my own machine
I want a run to work in a git worktree of a repository I already have, and to open that worktree in VS Code from the run page
So that I can watch, inspect and continue the agent's change in my editor instead of reading a diff in the browser

## Problem Statement

Today each agent step clones into a temp folder (`mkdtempSync(join(tmpdir(), 'azhi-opencode-'))`) that is deleted in the step's `finally` (`rmSync(root, …)`). Nothing on disk outlives a step, so there is nothing to open in an editor. A change exists only as the step's `workspace` output (files and a diff).

## Solution Statement

1. **A registry of local folders** per Azhi workspace: `name -> absolute path`, set by an admin in the UI, audited. A workflow names a folder (`workspace: { local: my-repo }`); the path never appears in workflow, ticket, issue or PR text. This mirrors how a workflow names a secret and never holds its value.
2. **Worker opt-in.** A worker declares the feature `workspace_local` only when started with local folders allowed (`azhi up --local-folders`, `AZHI_LOCAL_FOLDERS=1`). Off by default. The run plan blocks a run when no online worker has it.
3. **A worktree per run and folder**, created by the worker under its own data dir (`<dataDir>/worktrees/<runId>-<name>`), outside the user's repository, on branch `azhi/<runId>`. Reused by later steps and by activity retries. Never deleted by a step.
4. **The worker reports** the worktree (path, branch, base commit) to the server with the run token; the server stores it in `run_worktrees` and emits a `run.worktree` event. `GET /v1/runs/:id` returns it.
5. **Run page**: an "Open in VS Code" link (`vscode://file/<path>`) per active worktree, plus the path, branch and the cleanup command.
6. **Explicit cleanup**: `azhi worktree list` and `azhi worktree remove <run>` on the worker's machine. Nothing merges, pushes or deletes a branch.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: High
**Primary Systems Affected**: `definition`, `compiler`, `plan`, `runtime`, `worker`, `api`, `server`, `db`, `cli`, `web`, `docs`
**Dependencies**: none new. `git` >= 2.17 on the worker (`git worktree add/remove`); VS Code on the user's machine registers the `vscode://` scheme.

---

## CONTEXT REFERENCES

### Relevant Codebase Files. YOU MUST READ THESE BEFORE IMPLEMENTING

- `docs/desktop-app-plan.md` (lines 52-67) - the requirements this feature must meet, quoted in Acceptance Criteria.
- `src/worker/workspace.ts` (whole file) - `WorkspaceSpec`, `Checkout`, `isolatedGitEnv` (66), `cloneWorkspace` (105-222), `workGit` (246), `stageChange` (265), `restoreTree` (272), `collectChange` (280), `runWorkspaceTests` (344). The new worktree function returns the same `Checkout` so the rest is reused.
- `src/worker/continuation.ts` (27-48) - `HarnessWorkspace`, `resolveWorkspace`: the type the workflow sends the worker.
- `src/worker/harness-activity.ts` (124-155 checkout, 383-412 write mode, 448-455 cleanup) - OpenCode 1.x step.
- `src/worker/harness-opencode2.ts` (70-101 checkout, around 430 cleanup; find its write-mode block, same shape as 1.x) - OpenCode 2 step. Both files need the same change.
- `src/worker/capabilities.ts` (16-24, 93) - `WorkerFeature`, `WORKER_FEATURES`.
- `src/worker/worker.ts` (16-37, 80-81) - `WorkerOptions`, `dataDir`, how options reach `harnessActivities`.
- `src/worker/script-activity.ts` (22) - `ScriptWorkerOptions` (has `cacheDir`, `capabilities`, `api`).
- `src/worker/api-client.ts` (25-33) - `raw`, `get`, `post`, `put`.
- `src/definition/types.ts` (73-110) - `AgentWorkspace`.
- `src/definition/schema.ts` (183-209) - workspace JSON schema, `required: ['repo', 'ref']`.
- `src/compiler/compile.ts` (75, 387-425) - workspace checks and the `err(code, message, node, path)` / `warn(...)` pattern.
- `src/runtime/workflow.ts` (166-232) - `runHarness`: builds `workspace`, calls `harnessPrepare`, picks a worker with `needs`, calls `runHarness`.
- `src/runtime/activity-types.ts` (88, 146-158) - `harnessPrepare` input and `HarnessPlan`.
- `src/agents/model-agent.ts` (532 onward) - `harnessPrepare`: where the server resolves things for the worker.
- `src/runtime/gateway-activities.ts` (205-220, 265-272) - worker selection by `features`, the `harnessPrepare` activity.
- `src/plan/run-plan.ts` (25-38 `Mark`/`Enforcement`, 133-200 `opencodeSetup`) - requirements and coverage for a workspace.
- `src/plan/preflight.ts` (146 onward) - live repository check to skip for a local folder.
- `src/server/repo-slots.ts` (27-43) - `runRepos`: must not break when `repo` is absent.
- `src/server/runs.ts` (222-260) - `getRunDetail`.
- `src/api/app.ts` (342-347 run detail and the run-token check, 614-650 workers) and `src/api/auth.ts` (12, 54) - principals; `req.principal.kind === 'run'`.
- `src/api/mission.ts` (134-182) - settings routes: `user(req)`, `requireRole(p, 'admin')`, `z.object(...).parse`, `audit(...)`.
- `src/db/schema.ts` (156-185) and `migrations/0011_repo_concurrency.sql` - Drizzle table plus a matching SQL migration with a header comment.
- `src/local/up.ts` (15-20, 65-67) - `LocalOptions`, `startWorker` call.
- `src/cli/main.ts` - command registration; mirror an existing small command.
- `web/src/pages/Run.tsx` (87-105) - `PageHead` `actions`.
- `web/src/pages/Workers.tsx` (60-130) - settings cards using `useQuery`/`useMutation` (harness, concurrency).
- `web/src/pages/Editor.tsx` (1062-1115) - `WorkspaceFields`.
- `web/src/stepHelp.ts` (39, 98, 119, 192) and `web/src/lenses.ts` (52, 123-129) - text that assumes `workspace.repo`.
- `test/workspace-write.test.ts` (1-60) - worker-level git test pattern (`describe.skipIf(!hasGit)`, temp root, isolated env).
- `test/workspace-from-compile.test.ts` - compile-error test pattern.
- `test/repo-limit.test.ts` - API settings test pattern on PGlite.

### New Files to Create

- `migrations/0015_local_folders.sql` - `local_folders` and `run_worktrees`.
- `src/worker/worktree.ts` - `localWorktree`, `finishLocalStep`, `listWorktrees`, `removeWorktree`.
- `src/server/local-folders.ts` - registry reads and writes, worktree upsert.
- `src/api/local-folders.ts` - routes.
- `docs/local-workspaces.md` - feature doc.
- `test/workspace-local.test.ts` - worker.
- `test/workspace-local-compile.test.ts` - compiler.
- `test/local-folders-api.test.ts` - API and run plan.

### Relevant Documentation

- [git-worktree](https://git-scm.com/docs/git-worktree#_commands) - `add -b`, `remove`, `list --porcelain`, `prune`. Why: the commands used and what `remove` refuses (dirty tree without `--force`).
- [git-worktree: details](https://git-scm.com/docs/git-worktree#_details) - the worktree's `.git` is a file `gitdir: <repo>/.git/worktrees/<id>`. Why: the pointer file is inside the folder the agent edits.
- [VS Code: opening with URLs](https://code.visualstudio.com/docs/configure/command-line#_opening-vs-code-with-urls) - `vscode://file/{full path}`. Why: the link format; on Windows the path keeps its drive letter and uses forward slashes.
- [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) - Why: the folder holds agent-written code; the doc must say so.

### Patterns to Follow

**Errors (worker):** `ApplicationFailure.create({ type: ErrorClass.invalidInput, message, nonRetryable: true })`; `workspace.ts` has a local `invalid(message)` helper. Reuse it.

**Git on the worker:** never the host's config. Every command gets `isolatedGitEnv(home)` plus `GIT_CONFIG_COUNT/KEY_n/VALUE_n` pairs for `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.symlinks=false`, `credential.helper=` (see `cloneWorkspace` 121-125 and `workGit` 247-254). `execFile('git', args, { windowsHide: true, ... })`, never a shell string.

**Feature gating:** a new worker ability is a `WorkerFeature`; the workflow passes it in `needs` to `selectWorker` (`workflow.ts:208`) and the run plan adds a requirement that is `unverified` with no worker online, `native` when one has it, `unsupported` otherwise (`run-plan.ts:157-164`).

**Settings routes:** read for any user, write `requireRole(p, 'admin')` then `audit(ctx, p.workspaceId, p.userId, '<area>.<what>', body)` (`mission.ts:151-165`).

**Comments:** one short block comment above a function saying what and why, in plain sentences. Match the density of the file you are in.

**Rules from CLAUDE.md:** unknown values are `null`/"unavailable"; nothing merges, closes or force-pushes; ticket, issue and PR text never becomes a path, command or tool name.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (definition, compiler, storage)

Schema and types for `workspace.local`, compile checks, the two tables, the folder registry and its routes.

### Phase 2: Core (worker)

`src/worker/worktree.ts`, the worker opt-in and feature, both OpenCode harness files.

### Phase 3: Integration (runtime, plan, reporting)

`harnessPrepare` resolves the name to a path; the workflow asks for a `workspace_local` worker; the run plan marks it; the worker reports the worktree; run detail returns it.

### Phase 4: Surface (web, CLI, docs)

Folders card, editor fields, Run page link, `azhi worktree`, docs.

### Phase 5: Testing and validation

---

## STEP-BY-STEP TASKS

Execute in order. Each task is independently testable.

### 1. UPDATE `src/definition/types.ts` and `src/definition/schema.ts`

- **IMPLEMENT**: in `AgentWorkspace` make `repo` and `ref` optional and add `/** The name of a local folder registered in this workspace (Workers page). The run works in a git worktree of it; nothing is cloned. A literal name, never a value. */ local?: string;`. In the JSON schema add `local: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' }` and replace `required: ['repo', 'ref']` with `oneOf: [{ required: ['repo', 'ref'] }, { required: ['local'], not: { anyOf: [{ required: ['repo'] }, { required: ['host'] }, { required: ['credential'] }, { required: ['depth'] }, { required: ['merge_ref'] }, { required: ['from'] }] } }]`.
- **GOTCHA**: making `repo`/`ref` optional in the type will surface every place that assumes them. Fix each with a real branch, not `!`. Known: `compile.ts:75`, `workflow.ts:172-173`, `repo-slots.ts:30`, `run-plan.ts:147`, `preflight.ts:146`, `web/src/stepHelp.ts`, `web/src/lenses.ts`.
- **GOTCHA**: update the comment on `AgentNode.workspace` (types.ts:73), which says "cloned fresh on the worker and deleted after".
- **VALIDATE**: `npm run typecheck`

### 2. UPDATE `src/compiler/compile.ts`

- **IMPLEMENT**: next to the checks at 387-399 add, for `n.workspace?.local`: executor must be `opencode` (existing check covers it); the schema already rejects the excluded fields, so add only what the schema cannot say: `warn('workspace_local', "workspace.local works in a folder on the worker's machine that stays after the run; filesystem isolation is not enforced for it", n.id, 'workspace.local')`. At line 75 keep the map working when `repo` is undefined.
- **PATTERN**: `err`/`warn` calls at `compile.ts:387-399`.
- **GOTCHA**: this file has uncommitted triggers edits. Add lines only.
- **VALIDATE**: `npx vitest run test/workspace-local-compile.test.ts` (written in task 16) and `npx vitest run test/workspace-from-compile.test.ts`

### 3. CREATE `migrations/0015_local_folders.sql`, UPDATE `src/db/schema.ts`

- **IMPLEMENT**:
  ```sql
  -- Local folders (src/server/local-folders.ts). A workflow names one (workspace.local); the path is
  -- on the worker's machine and is set by an admin, never taken from a workflow, ticket or PR.
  -- A run's worktree of a folder is recorded so the run page can show where it is.
  CREATE TABLE IF NOT EXISTS local_folders (
    workspace_id text NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, name)
  );
  CREATE TABLE IF NOT EXISTS run_worktrees (
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    folder text NOT NULL,
    path text NOT NULL,
    branch text NOT NULL,
    base_sha text NOT NULL,
    worker_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    PRIMARY KEY (run_id, folder)
  );
  ```
  Add matching `pgTable` definitions in `src/db/schema.ts` after `runEvents`, using the file's `ts(...)` helper.
- **GOTCHA**: confirm how migrations are discovered (grep `migrations` in `src/db`); if there is a list or a count asserted in a test, extend it. `0014_triggers.sql` is untracked; do not renumber or edit it.
- **VALIDATE**: `npm run test:local -- test/repo-limit.test.ts` (any PGlite test applies all migrations)

### 4. CREATE `src/server/local-folders.ts`

- **IMPLEMENT**:
  - `listLocalFolders(ctx, workspaceId)`, `setLocalFolder(ctx, workspaceId, name, path, userId)` (upsert), `deleteLocalFolder(ctx, workspaceId, name)`, `localFolderPath(ctx, workspaceId, name): Promise<string | undefined>`.
  - `validFolderPath(path)`: absolute (`node:path` `isAbsolute` for the server's platform **or** matching `^[A-Za-z]:[\\/]` or `^/`, since the worker may be another OS), no NUL, no `..` segment, length <= 1024. The server cannot check that the folder exists; the worker does.
  - `recordWorktree(ctx, workspaceId, runId, w: { folder, path, branch, base_sha, worker_id? })`: upsert into `run_worktrees` (on conflict keep the row, clear `removed_at`), and insert a `run_events` row `kind='run.worktree'`, `node_id`, `data` = the row, only when the row was new.
  - `markWorktreeRemoved(ctx, workspaceId, runId, folder)`.
- **PATTERN**: query style of `src/server/repo-slots.ts` (45-55).
- **VALIDATE**: `npm run typecheck`

### 5. CREATE `src/api/local-folders.ts`, register it in `src/api/app.ts`

- **IMPLEMENT**:
  - `GET /v1/local-folders` (any user) -> `{ folders: [{ name, path, created_at }], workers: [names of online workers with feature workspace_local] }`.
  - `PUT /v1/local-folders/:name` (admin) body `{ path }` -> validate name against the schema pattern and `validFolderPath`; `audit(..., 'local_folder.set', { name, path })`.
  - `DELETE /v1/local-folders/:name` (admin), audited.
  - `POST /v1/runs/:id/worktrees` body `{ folder, path, branch, base_sha, node }`: accepts a **run principal** whose `claims.run === :id` (same check as `app.ts:345`), or an operator user; calls `recordWorktree`. The server checks that `folder` is registered and that `path` is not inside the registered folder's own path and is absolute.
  - `POST /v1/runs/:id/worktrees/:folder/removed` (operator user, used by the CLI) -> `markWorktreeRemoved`.
- **PATTERN**: how `src/api/triggers.ts` or `src/api/mission.ts` exports a `register…(app, ctx)` function and how `app.ts` calls it.
- **GOTCHA**: confirm a run token is allowed to call a POST route (grep how `/v1/gateway/credentials` or the transcript upload authorises a run principal) and follow that exact guard.
- **VALIDATE**: `npx vitest run test/local-folders-api.test.ts`

### 6. UPDATE `src/worker/capabilities.ts`, `src/worker/worker.ts`, `src/worker/script-activity.ts`, `src/local/up.ts`, `src/cli/main.ts`

- **IMPLEMENT**: add `'workspace_local'` to `WorkerFeature` (not to `WORKER_FEATURES`); document it in the comment block at capabilities.ts:19-22. Add `localFolders?: boolean` to `WorkerOptions` and `ScriptWorkerOptions` (default `process.env.AZHI_LOCAL_FOLDERS === '1'`); when true, push `'workspace_local'` into the capabilities' `features` and pass `localFolders: true` and `worktreeDir: join(dataDir, 'worktrees')` to `harnessActivities`. Add `localFolders?: boolean` to `LocalOptions` and pass it to `startWorker`. Add `--local-folders` to `azhi up` and to the worker start command.
- **GOTCHA**: off unless asked for. Do not turn it on in `azhi up` by default.
- **VALIDATE**: `npm run typecheck`; `npm run azhi -- up --help` shows the flag

### 7. CREATE `src/worker/worktree.ts`

- **IMPLEMENT**:
  ```ts
  export interface LocalWorkspace { name: string; path: string; ref?: string; baseRef?: string; mode?: 'write'; test?: WorkspaceSpec['test'] }
  export interface WorktreeInfo { folder: string; path: string; branch: string; base_sha: string; created: boolean }
  export async function localWorktree(w: LocalWorkspace, o: { runId: string; worktreeDir: string; home: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ checkout: Checkout; info: WorktreeInfo; release(): void }>
  ```
  Steps inside `localWorktree`:
  1. Validate: `w.path` absolute; `REF` regex (export it from `workspace.ts`) for `ref` (default `HEAD`) and `baseRef`; `runId` matches `^[A-Za-z0-9_-]+$`.
  2. `git -C <path> rev-parse --show-toplevel` must equal `realpathSync(w.path)` (compare case-insensitively on Windows, forward slashes), and `rev-parse --is-bare-repository` must be `false`. Otherwise `invalid("local folder '<name>' is not the top of a git repository on this worker")`.
  3. `dir = join(o.worktreeDir, `${runId}-${name}`)`, `branch = `azhi/${runId}``, sidecar `join(o.worktreeDir, `${runId}-${name}.json`)` holding `{ folder, path: dir, repo: w.path, branch, base_sha, git_dir }`.
  4. Take a lock: `mkdirSync(`${dir}.lock`)` in a retry loop (250 ms) until it succeeds, the signal aborts or `timeoutMs` passes; `release()` removes it. A lock older than 12 hours is stale and is replaced. This serialises parallel steps of one run on one folder.
  5. If the sidecar exists and `dir` exists: reuse (`created: false`). Else `git -C <path> worktree add -b <branch> <dir> <ref>` (if the branch exists from a retried attempt: `worktree add <dir> <branch>`), then `base_sha = rev-parse HEAD` in the worktree, `git_dir = rev-parse --absolute-git-dir`, write the sidecar.
  6. If `baseRef`: `base = rev-parse <baseRef>^{commit}` in the repository.
  7. Return `Checkout { dir, head: base_sha, gitDir: git_dir, ...(base ? { base } : {}) }`. `gitDir` is set in read mode too: harness code must decide "writable" from `mode`, see task 8.
  - `finishLocalStep(checkout, home, nodeId)`: rewrite `<dir>/.git` to exactly `gitdir: <git_dir>\n` if its content differs or it is not a regular file (delete and rewrite); then, if the index differs from `HEAD`, `git commit -q --no-verify --no-gpg-sign -m "azhi: <nodeId>"` with the `azhi` identity used in `workspace.ts:178`. Returns `{ pointer_restored: boolean; committed: boolean }`.
  - `listWorktrees(worktreeDir)`: reads the sidecars. `removeWorktree(worktreeDir, id, { force })`: `git -C <repo> worktree remove [--force] <dir>`, delete the sidecar and lock; **never** deletes the branch.
- **PATTERN**: env and `execFile` wrapper from `cloneWorkspace` (120-134) and `workGit` (246-262). Reuse `isolatedGitEnv`. Do not set `GIT_ALLOW_PROTOCOL` to a network protocol: no fetch happens.
- **GOTCHA**: `git -C <path>` reads the repository's own `.git/config`. Keep the `GIT_CONFIG_*` overrides (hooks off, fsmonitor off) on every command so nothing in it runs a program.
- **GOTCHA**: the user's repository gains one branch and one `.git/worktrees/<id>` entry. Nothing else in it changes; its working tree and `HEAD` are untouched. Assert that in the test.
- **GOTCHA**: `core.symlinks=false` applies to the worker's commands only, so a repository with symlinks shows them as changed files to the user's own git. Document it; do not write to the repository's config.
- **VALIDATE**: `npx vitest run test/workspace-local.test.ts`

### 8. UPDATE `src/worker/continuation.ts`, `src/worker/harness-activity.ts`, `src/worker/harness-opencode2.ts`

- **IMPLEMENT**:
  - `HarnessWorkspace` becomes `(Omit<WorkspaceSpec, 'continuation'> & { continuation?: … }) | { local: LocalWorkspace }`; `resolveWorkspace` is called only for the first shape.
  - In both harness files, where `cloneWorkspace` is called (activity 142-151, opencode2 88-97): if `'local' in input.workspace`, refuse unless `o.localFolders` (`ErrorClass.unsupportedCapability`, non-retryable: "this worker does not allow local folders"), call `localWorktree(...)`, then report it: `await runApi.post(`/v1/runs/${encodeURIComponent(input.runId)}/worktrees`, { ...info, node: input.nodeId })` (a failed report is logged to the transcript sink as a note and does not fail the step), and `sink.put` a note with the path and branch.
  - Replace `const writable = Boolean(checkout?.gitDir)` with a value that is true only for `mode === 'write'` (remote: unchanged meaning; local: `input.workspace.local.mode === 'write'`). Search each file for every other `checkout?.gitDir` / `checkout.gitDir` test (activity 383) and switch them to `writable`.
  - Write-mode result (activity 409): `repo` is `local:<name>`, `ref` is the branch.
  - In `finally`, before `rmSync(root, …)`: for a local workspace call `finishLocalStep(...)` inside its own try/catch, then `release()`. `rmSync(root)` stays: the worktree is not under `root`.
  - `writeOpencodeSetup(... workspace: project)` and the MCP `AZHI_WORKSPACE` already take `project`; no change.
- **GOTCHA**: `isolatedGitEnv(home)` uses a `home` under `root`, which is fine: only the step's HOME is temporary.
- **GOTCHA**: OpenCode's `external_directory: 'deny'` keeps edits inside the worktree; the repository's real git directory is outside it, as the moved `gitDir` is for a clone.
- **VALIDATE**: `npm run typecheck`; `npx vitest run test/workspace-write.test.ts test/workspace-continuation.test.ts test/workspace-merge.test.ts`

### 9. UPDATE `src/runtime/workflow.ts`, `src/runtime/activity-types.ts`, `src/agents/model-agent.ts`

- **IMPLEMENT**: in `runHarness` (168-181) build, for `ws.local`, `{ local: { name: ws.local, ref?, baseRef?, mode?, test? } }` with the same value resolution as today. Pass `workspace: { local: ws.local, mode }` to `harnessPrepare`; widen its input type at `activity-types.ts:88` and `model-agent.ts:532`. `harnessPrepare` resolves the path with `localFolderPath` and returns it on `HarnessPlan` as `localFolder?: { name: string; path: string }`; unknown name -> `AzhiError(ErrorClass.invalidInput, "local folder '<name>' is not registered in this workspace")`. The workflow puts `prep.localFolder.path` into the worker's `workspace.local.path`. Add `'workspace_local'` to `needs` (208). `issueRunToken`'s credential list (210) gets no workspace credential for a local folder.
- **GOTCHA**: this is Temporal workflow code. A new field read from an activity result changes nothing for runs already in history, but a changed command sequence would. Only add fields; add no new activity call in the workflow. Read how other additive changes were guarded (grep `patched(` in `src/runtime`), and follow it if `needs` changes the `selectWorker` call for existing workspace steps (it must not: add the feature only when `ws.local`).
- **GOTCHA**: the path is resolved at step time, not at run start, so a registry change mid-run moves later steps. Acceptable: the worktree is reused by its sidecar, which holds the original repository path.
- **VALIDATE**: `npm run typecheck`; `npx vitest run test/workspace-from-prepare.test.ts`

### 10. UPDATE `src/plan/run-plan.ts`, `src/plan/preflight.ts`, `src/server/repo-slots.ts`

- **IMPLEMENT** in `opencodeSetup` (133), when `ws.local`:
  - requirement `local folder <name>`: `native` with detail `registered` or `unsupported` with `not registered; an admin adds it on the Workers page` (load the registry once near `secrets` at line 90);
  - requirement `worker allows local folders`: `unverified` / `native` / `unsupported`, same shape as 157-164, feature `workspace_local`;
  - coverage `{ action: 'works in a local folder', enforcement: 'unobservable', detail: "a git worktree of '<name>' on the worker's machine, on branch azhi/<run id>; it is not a temporary directory and is not deleted when the step or the run ends. The gateway cannot see what is read or written there. Nothing is merged or pushed" }`;
  - skip the `workspace clone` coverage and the credential requirement; keep `edits in the checkout` and the test-command coverage, adjusting the first to say git metadata is in the repository's own git directory, outside the worktree.
- `preflight.ts:146`: no live repository check for a local folder; emit an `ok` check saying it is checked on the worker when the step starts, in the file's existing check shape.
- `repo-slots.ts:30`: skip a workspace without `repo` (a local folder holds no slot; each run has its own worktree).
- **VALIDATE**: `npx vitest run test/local-folders-api.test.ts test/repo-limit.test.ts`

### 11. UPDATE `src/server/runs.ts`

- **IMPLEMENT**: in `getRunDetail` add a query `SELECT folder, path, branch, base_sha, worker_id, created_at, removed_at FROM run_worktrees WHERE run_id=$1 ORDER BY created_at` to the `Promise.all` and return it as `worktrees`.
- **VALIDATE**: covered by `test/local-folders-api.test.ts`

### 12. UPDATE `src/cli/main.ts`

- **IMPLEMENT**: `azhi worktree list` prints each sidecar (run, folder, path, branch). `azhi worktree remove <run> [--folder <name>] [--force]` calls `removeWorktree`, then `POST /v1/runs/<run>/worktrees/<folder>/removed` with the CLI's token; a failed POST is reported, not fatal. Both read `<AZHI_HOME or ~/.azhi>/worker/worktrees` (`localHome` from `src/local/up.ts`).
- **GOTCHA**: without `--force`, git refuses a worktree with uncommitted or untracked files; print git's message and exit non-zero. The branch `azhi/<run>` is left in place; say so in the output.
- **PATTERN**: an existing small command in `src/cli/main.ts`. This file has triggers edits; add only.
- **VALIDATE**: `npm run azhi -- worktree list`

### 13. UPDATE `web/src/api.ts`, `web/src/pages/Workers.tsx`

- **IMPLEMENT**: a "Local folders" card after the concurrency card: table of name and path, add form (name, absolute path), remove button with the page's confirm dialog; admin only for changes. Text under it: "A workflow can work in a git worktree of one of these folders instead of cloning a repository. The path is on the worker's machine. Only a worker started with local folders allowed (`azhi up --local-folders`) uses them." Show "No online worker allows local folders" from the `workers` array when it is empty.
- **GOTCHA**: a browser folder picker never gives an absolute path, so this is a text field. The desktop app can fill the same field from a native dialog later.
- **PATTERN**: the harness and concurrency cards at `Workers.tsx:60-130`.
- **VALIDATE**: `npm run typecheck`; `npm run build:web`

### 14. UPDATE `web/src/pages/Editor.tsx`, `web/src/stepHelp.ts`, `web/src/lenses.ts`

- **IMPLEMENT**: in `WorkspaceFields`, under the checkbox, a two-option choice "Clone a repository" / "Use a local folder". Local shows a `<select>` of registered folders (`GET /v1/local-folders`, plus the current value if it is not in the list), the ref field (placeholder `HEAD`) and base ref, the write checkbox and test command; it hides repository, credential, host, depth and "Continue from". Switching mode drops the other mode's keys. Update the helper text at 1058-1061 and the strings in `stepHelp.ts` (39, 119, 192) and `lenses.ts` (52, 123-129) so a local folder reads as "a worktree of the local folder <name>".
- **VALIDATE**: `npm run typecheck`; `npm run build:web`

### 15. UPDATE `web/src/pages/Run.tsx`

- **IMPLEMENT**: from `d.worktrees` (active = `removed_at` null) render, in `PageHead` `actions` before the existing buttons and for every signed-in user, `<a className="button" href={vscodeUrl(w.path)} title={w.path}>Open in VS Code</a>` (label `Open <folder> in VS Code` when there is more than one). `vscodeUrl = (p) => 'vscode://file/' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')`. Below the head, a small panel "Worktree": folder, path (mono, with the page's existing copy control if there is one), branch, base commit (12 chars), and "This folder is on the worker's machine and holds code written by an agent. Remove it with `azhi worktree remove <run id>`." Removed worktrees show as removed with no link.
- **GOTCHA**: this file has uncommitted edits; add only. Check how other `<a>` styled as buttons look in this app (grep `className="button"` or similar) and use that class.
- **GOTCHA**: the run detail query refetches while the run is open, so the link appears when the first step reports the worktree. Confirm the query has a refetch interval or is invalidated by the event stream; if neither, invalidate on a `run.worktree` event.
- **VALIDATE**: `npm run typecheck`; `npm run build:web`

### 16. CREATE tests

- `test/workspace-local.test.ts` (mirror `workspace-write.test.ts`, `describe.skipIf(!hasGit)`):
  - creates a worktree on `azhi/<run>` at the repository's `HEAD`; the repository's own working tree, `HEAD` and `git status` are unchanged; a second call reuses it (`created: false`);
  - write mode: edit files, `stageChange` + `collectChange` return the change against `base_sha`; `finishLocalStep` commits it; a second step's change is cumulative from `base_sha`;
  - a hook in the repository's `.git/hooks/post-checkout` and `pre-commit` does not run (it would write a marker file);
  - the `.git` pointer file replaced by the "agent" with `gitdir: ./evil` is restored by `finishLocalStep`;
  - not a git repository, a subfolder of one, and a bare repository are refused with `invalid_input`;
  - a bad `ref` (`--upload-pack=x`, `a..b`) is refused before git runs;
  - two concurrent `localWorktree` calls for one run: the second waits for `release()`;
  - `removeWorktree` refuses a dirty tree without `force`, removes with it, and leaves the branch.
- `test/workspace-local-compile.test.ts` (mirror `workspace-from-compile.test.ts`): `local` alone compiles with the `workspace_local` warning; `local` with `repo`, `credential`, `from` or `merge_ref` fails schema validation; `local: {ref: inputs.x}` fails; non-opencode executor -> `workspace_unsupported`.
- `test/local-folders-api.test.ts` (mirror `repo-limit.test.ts`): admin sets and deletes a folder, a non-admin gets 403, a relative path is refused; the run plan marks the folder `unsupported` when unregistered and the worker requirement `unsupported` when no worker has `workspace_local` (insert a `workers` row with and without the feature); `POST /v1/runs/:id/worktrees` with that run's token records it once and emits one `run.worktree` event, with another run's token is refused; `GET /v1/runs/:id` returns `worktrees`.
- **VALIDATE**: `npm run test:local`

### 17. CREATE `docs/local-workspaces.md`, UPDATE `docs/desktop-app-plan.md`, `README.md`

- **IMPLEMENT**: the doc covers: what it is, turning it on (`--local-folders`), registering a folder, the YAML (`workspace: { local: my-repo, mode: write }`), where the worktree and branch are, the Run page link, cleanup, and a **Limits** section: filesystem isolation is not enforced; test commands run repository code on your machine; the worktree holds agent-written code, so VS Code Workspace Trust applies; symlinks check out as plain files; one worker machine only (no VS Code Remote); nothing is merged or pushed. In `desktop-app-plan.md` line 58-66 mark the item as built here and the worktree question as settled, linking the doc. One line in `README.md` where features are listed.
- **PATTERN**: tone and length of `docs/triggers.md` or another `docs/*.md` feature file.
- **GOTCHA**: `README.md` has uncommitted edits; add one line only.
- **VALIDATE**: `npm run typecheck && npm run test:local && npm run build:web`

---

## TESTING STRATEGY

Vitest on PGlite (`npm run test:local`). Git tests skip when git is absent and use an isolated env (`GIT_CONFIG_GLOBAL=/dev/null`, own `HOME`), as `workspace-write.test.ts` does.

### Unit Tests

`test/workspace-local.test.ts`, `test/workspace-local-compile.test.ts` (task 16).

### Integration Tests

`test/local-folders-api.test.ts`: routes, run plan, worktree reporting, run detail.

No test drives OpenCode itself; the harness wiring (task 8) is covered by typecheck and the manual run below. Say so in the PR.

### Edge Cases

- Activity retry after the worktree was created (reuse, branch already exists).
- Path with spaces and, on Windows, a drive letter and backslashes (link encoding, `show-toplevel` comparison).
- Folder registered, then removed from the registry mid-run.
- Worker restarted between steps (sidecar on disk, stale lock).
- Two parallel write steps on one folder (serialised by the lock).
- Repository with hooks, `core.fsmonitor`, or symlinks.
- Worktree deleted by hand: the next step recreates it from the branch; `worktree list` still shows a stale entry until `git worktree prune`.

### E2E / Browser

There is no `agent-browser` skill in this repository. Use the app's preview tools with the `web-dev` configuration in `.claude/launch.json` (or `npm run azhi -- up --local-folders`).

- Happy path: Workers page -> add folder -> editor -> step uses the local folder -> run -> Run page shows "Open in VS Code" whose `href` starts with `vscode://file/` and ends with the worktree path. Screenshot the Run page head.
- Error paths: relative path refused in the folder form; a run with an unregistered folder shows the blocker in the run plan. Screenshot each.

---

## VALIDATION COMMANDS

### Level 1: Types

```bash
npm run typecheck
```

### Level 2: Unit

```bash
npx vitest run test/workspace-local.test.ts test/workspace-local-compile.test.ts
```

### Level 3: Integration and regressions

```bash
npm run test:local
```

```bash
npm run build:web
```

### Level 4: Manual

1. `npm run azhi -- up --local-folders`
2. Workers page: add `demo` -> an absolute path to a scratch git repository.
3. A one-step workflow: `executor: opencode`, `workspace: { local: demo, mode: write }`. Run it.
4. Run page: the link opens VS Code on `<~/.azhi>/worker/worktrees/<run>-demo`; `git -C <repo> branch` lists `azhi/<run>`; the repository's own working tree is unchanged.
5. `npm run azhi -- worktree remove <run>`; the Run page shows the worktree as removed; the branch is still there.

---

## ACCEPTANCE CRITERIA

From `docs/desktop-app-plan.md`:

- [ ] Off by default, opt-in per workflow, and recorded in the run plan as a capability with its own policy coverage mark (not "enforced" for filesystem isolation).
- [ ] The folder is chosen in the UI by the user, never taken from workflow, ticket, issue or PR text.
- [ ] Writes still go through the gateway and ledger; the approval gate and taint rule apply unchanged.
- [ ] Nothing merges, closes or force-pushes: a git folder gets a branch, not a push to the default branch.

From the request:

- [ ] A run whose step uses a local folder works in a git worktree of it, and the worktree stays after the run.
- [ ] The Run page offers "Open in VS Code" for a run that has a worktree, and not for one that has none.
- [ ] A worker without `--local-folders` never opens a local folder, and the run plan blocks the run.
- [ ] Hooks and config in the user's repository run nothing during a step.
- [ ] Existing clone workspaces behave as before (all `test/workspace-*.test.ts` pass unchanged).
- [ ] The uncommitted triggers work is intact.

---

## COMPLETION CHECKLIST

- [ ] All tasks done in order, each validated
- [ ] `npm run typecheck`, `npm run test:local`, `npm run build:web` pass
- [ ] Manual run (Level 4) done, with a screenshot of the Run page
- [ ] `docs/local-workspaces.md` written; `desktop-app-plan.md` updated
- [ ] Conventional commit (`feat:`) on `dev`; PR targets `dev`

---

## NOTES

**Decisions**

- *Named folders, not a path in the workflow.* The requirement is that the path never comes from workflow or ticket text. A registry keyed by name gives that, and a published workflow stays portable.
- *One worktree per run and folder, shared by the run's steps.* That is what makes it openable while the run is going, and later steps see earlier edits with no `workspace.from`. Cost: parallel steps on one folder are serialised by a lock.
- *Worktree under the worker's data dir, not inside the repository.* The user's repository gains a branch and nothing else.
- *Commit after each write step.* The next step and the user both start from a clean tree, and `collectChange` still measures from `base_sha`, so a step's `workspace` output is the run's cumulative change. If the user would rather have uncommitted edits, drop the commit in `finishLocalStep`; nothing else depends on it.
- *Cleanup by CLI, not from the Run page.* The server has no channel to ask a worker to delete a folder outside a workflow activity. A button can come later with a worker task queue command.
- *`unobservable` coverage.* `Enforcement` has no weaker mark; this one says plainly that the gateway cannot see the folder.

**Risks**

- The `.git` pointer file is inside the folder the agent edits. The worker never trusts it (it sets `GIT_DIR`), and restores it after each step, but between an edit and the end of the step a user's own editor would read the altered pointer. Stated in the doc's Limits.
- A step killed hard (worker crash) leaves a lock; it goes stale after 12 hours or is removed by `azhi worktree remove`.
- Temporal determinism in `workflow.ts` (task 9): additive only.
- Not verified while planning: how a run principal is authorised on POST routes (task 5), how migrations are listed (task 3), whether the run detail query refetches (task 15), and the OpenCode 2 write-mode block's line numbers (task 8).

**Out of scope**: remote workers and VS Code Remote; a native folder dialog (desktop app); pushing the run branch (an existing gated write tool would need a `local:` repository mapping); `merge_ref` and `from` with a local folder; a Run page remove button.

**Confidence**: 7/10 for one pass. The worker and API parts follow existing patterns closely; the two harness files and the Temporal workflow edit are where a second pass is most likely.
