import { CancelledFailure, Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BridgeState, BridgeTool } from '../agents/gateway-mcp.js';
import { MAX_REPAIRS } from '../agents/model-agent.js';
import { SUBMIT_TOOL } from '../agents/providers.js';
import { chatgptAuth, type ChatgptAuth } from '../agents/chatgpt-auth.js';
import { CLAUDE_PLAN_ONLY_SDK, isClaudePlanToken } from '../executors/capabilities.js';
import { ErrorClass } from '../lib/errors.js';
import { killTree } from '../lib/process.js';
import { ApiClient } from './api-client.js';
import type { WorkerCapabilities } from './capabilities.js';
import { DCP_CONFIG, pathWithRipgrep, SEARCH_FIRST_GUIDANCE, tokenSavingOn } from './tools.js';
import { runClaudeAgentSdk } from './harness-claude.js';
import { runCodex } from './harness-codex.js';
import { readProfileHarness, writeOpencodeSetup } from './opencode-setup.js';
import { preparePackage, type ScriptWorkerOptions } from './script-activity.js';
import { cloneWorkspace, isolatedGitEnv, type WorkspaceSpec } from './workspace.js';
import { OpencodeTranscript } from './opencode-transcript.js';
import { TranscriptSink } from './transcript.js';

/**
 * The OpenCode harness adapter (spec section 9). OpenCode runs headless in a scratch project with
 * an isolated HOME, built-in tools switched off and every permission denied; the only tools it
 * sees are the Azhi gateway bridged over stdio MCP. Output comes back through submit_output and
 * is validated by the bridge. OpenCode owns its context and compaction, so the context manifest
 * lists what Azhi put in and marks the rest as harness-owned.
 */
export const OPENCODE_AMBIENT_TOOLS = ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'patch', 'apply_patch', 'webfetch', 'websearch', 'todowrite', 'todoread', 'task', 'skill', 'question', 'codesearch', 'lsp', 'multiedit'];
const MCP_NAME = 'azhi';

export interface HarnessInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  packageHash: string;
  /** Which harness runs the node; OpenCode when absent (older histories). */
  executor?: 'opencode' | 'claude-agent-sdk' | 'codex';
  provider?: 'anthropic' | 'openai' | 'github-copilot' | 'openai-chatgpt';
  runToken: string;
  /** Workspace secret holding the provider key; fetched with the run token, never put in history. */
  credential: string;
  providerUrl: string;
  /** With a custom Copilot endpoint: the models it serves (declared to OpenCode, which cannot list them). */
  endpointModels?: string[];
  model: string;
  system: string;
  prompt: string;
  tools: BridgeTool[];
  outputSchema: Record<string, unknown>;
  maxToolCalls?: number;
  timeoutMs: number;
  /** The agent profile, read from the verified package for its harness section. Absent in older histories. */
  profile?: string;
  /** A checkout the harness works in (OpenCode only). */
  workspace?: WorkspaceSpec;
}

export interface HarnessResult {
  output?: unknown;
  error?: { class: string; message: string };
  usage: { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; reasoning_tokens: number | null };
  model_calls: number;
  tool_calls: number;
  repairs: number;
  duration_ms: number;
  harness: { name: 'opencode' | 'claude-agent-sdk' | 'codex'; version: string };
}

/**
 * OpenCode's GitHub Copilot sign-in from the stored secret: the GitHub OAuth token from the Copilot
 * device flow, or OpenCode's own auth.json (or its github-copilot entry) pasted as is.
 */
export function copilotAuth(value: string): { type: 'oauth'; refresh: string; access: string; expires: number; enterpriseUrl?: string } & Record<string, unknown> {
  const v = value.trim();
  if (v.startsWith('{')) {
    try {
      const j = JSON.parse(v);
      const e = j['github-copilot'] ?? j['github-copilot-enterprise'] ?? j;
      if (typeof e?.refresh === 'string' && e.refresh) return { ...e, type: 'oauth', refresh: e.refresh, access: e.access ?? e.refresh, expires: typeof e.expires === 'number' ? e.expires : 0, ...(e.enterpriseUrl ? { enterpriseUrl: String(e.enterpriseUrl) } : {}) };
    } catch {
      // not JSON: a token
    }
    throw ApplicationFailure.create({ type: ErrorClass.authorization, message: 'the GitHub Copilot credential is JSON but has no github-copilot sign-in in it', nonRetryable: true });
  }
  return { type: 'oauth', refresh: v, access: v, expires: 0 };
}

export function harnessActivities(o: ScriptWorkerOptions & { capabilities: WorkerCapabilities }) {
  return {
    async runHarness(input: HarnessInput): Promise<HarnessResult> {
      if (input.executor === 'claude-agent-sdk') return runClaudeAgentSdk(o, input);
      if (input.executor === 'codex') return runCodex(o, input);
      const oc = o.capabilities.runtimes.opencode;
      if (!oc) throw ApplicationFailure.create({ type: ErrorClass.unsupportedCapability, message: 'this worker has no OpenCode', nonRetryable: true });
      // Same trust check as scripts: the package's profile is what the harness runs.
      const pkg = await preparePackage(o, input.packageHash);
      const profileHarness = input.profile ? readProfileHarness(pkg.dir, input.profile) : undefined;
      const ctx = Context.current();
      const runApi = new ApiClient(o.api.baseUrl, input.runToken);
      const key = await runApi.get<{ value: string }>(`/v1/gateway/credentials/${encodeURIComponent(input.credential)}`).catch((e) => {
        throw ApplicationFailure.create({ type: ErrorClass.authorization, message: `provider credential ${input.credential}: ${(e as Error).message}`, nonRetryable: true });
      });

      const root = mkdtempSync(join(tmpdir(), 'azhi-opencode-'));
      const home = join(root, 'home');
      const configDir = join(root, 'config');
      mkdirSync(home);
      mkdirSync(configDir);
      const stateFile = join(root, 'bridge-state.json');
      const bridgeBin = fileURLToPath(new URL('../../bin/azhi-gateway-mcp.js', import.meta.url));
      const started = Date.now();
      const hb = setInterval(() => ctx.heartbeat(), 5000);
      let proc: ChildProcess | undefined;
      let sink: TranscriptSink | undefined;
      let transcript: OpencodeTranscript | undefined;
      let workspaceToken: string | undefined;
      let chatgptSignIn: ChatgptAuth | undefined;
      try {
        // The step's directory: a fresh checkout when the node has a workspace, else an empty folder.
        let project = join(root, 'project');
        if (input.workspace) {
          const token = (workspaceToken = input.workspace.credential
            ? (
                await runApi.get<{ value: string }>(`/v1/gateway/credentials/${encodeURIComponent(input.workspace.credential)}`).catch((e) => {
                  throw ApplicationFailure.create({ type: ErrorClass.authorization, message: `workspace credential ${input.workspace!.credential}: ${(e as Error).message}`, nonRetryable: true });
                })
              ).value
            : undefined);
          project = (await cloneWorkspace(input.workspace, { root, home, token, timeoutMs: Math.min(input.timeoutMs, 600_000), signal: ctx.cancellationSignal })).dir;
        } else {
          mkdirSync(project);
        }
        const copilot = input.provider === 'github-copilot';
        const chatgpt = input.provider === 'openai-chatgpt';
        const providerID = copilot ? 'github-copilot' : chatgpt ? 'openai' : 'anthropic';
        // The server renews a ChatGPT sign-in before handing it out (src/api/chatgpt.ts); OpenCode only uses it.
        chatgptSignIn = chatgpt ? chatgptAuth(key.value) : undefined;
        if (chatgpt && !chatgptSignIn) throw ApplicationFailure.create({ type: ErrorClass.authorization, message: `credential ${input.credential} is not a ChatGPT sign-in; sign in with \`azhi chatgpt login\``, nonRetryable: true });
        if (!copilot && !chatgpt && isClaudePlanToken(key.value)) throw ApplicationFailure.create({ type: ErrorClass.unsupportedCapability, message: CLAUDE_PLAN_ONLY_SDK, nonRetryable: true });
        // Token saving adds search-first reading rules to the step's prompt (off unless the profile or the worker setting turns it on).
        const system = tokenSavingOn(profileHarness?.token_saving) ? `${input.system}\n\n${SEARCH_FIRST_GUIDANCE}` : input.system;
        // DCP prunes stale tool output when token saving is on and the plugin is installed on this worker (azhi setup --dcp).
        const dcp = tokenSavingOn(profileHarness?.token_saving) ? o.capabilities.runtimes.dcp : undefined;
        if (dcp) writeFileSync(join(configDir, 'dcp.json'), JSON.stringify(DCP_CONFIG));
        const setup = profileHarness ? writeOpencodeSetup(profileHarness, { pkgDir: pkg.dir, configDir, system, gitEnv: isolatedGitEnv(home), workspace: input.workspace ? project : undefined }) : undefined;
        writeFileSync(
          join(configDir, 'opencode.json'),
          JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            provider: chatgpt
              ? // OpenCode's own ChatGPT plugin sends the requests to OpenAI's Codex endpoint and lists the plan's models.
                { openai: {} }
              : copilot
              ? {
                  // Copilot's endpoint and model list are OpenCode's own; only a stand-in or proxy URL is set here.
                  'github-copilot': input.providerUrl
                    ? { options: { baseURL: input.providerUrl.replace(/\/$/, '') }, models: Object.fromEntries((input.endpointModels ?? [input.model]).map((m) => [m, { name: m, tool_call: true, limit: { context: 200000, output: 8192 } }])) }
                    : {},
                }
              : {
                  anthropic: {
                    options: { baseURL: `${input.providerUrl.replace(/\/$/, '')}/v1`, apiKey: key.value },
                    models: { [input.model]: { name: input.model, tool_call: true, limit: { context: 200000, output: 8192 } } },
                  },
                },
            mcp: {
              [MCP_NAME]: {
                type: 'local',
                command: [process.execPath, bridgeBin],
                // OpenCode gives an MCP server 30 s to connect by default; the first start of a slow or scanned machine can need longer.
                timeout: MCP_CONNECT_MS,
                environment: {
                  AZHI_URL: o.api.baseUrl,
                  AZHI_RUN_TOKEN: input.runToken,
                  AZHI_BRIDGE_TOOLS: JSON.stringify(input.tools),
                  AZHI_BRIDGE_OUTPUT_SCHEMA: JSON.stringify(input.outputSchema),
                  AZHI_BRIDGE_STATE: stateFile,
                  ...(input.maxToolCalls !== undefined ? { AZHI_BRIDGE_MAX_TOOL_CALLS: String(input.maxToolCalls) } : {}),
                },
                enabled: true,
              },
              ...(setup?.mcp ?? {}),
            },
            // Built-in tools off, then only the bridge's tools (and the profile's read-only tools and MCP servers) on;
            // every permission denied, so reads stay inside the step's directory.
            tools: { '*': false, ...Object.fromEntries(OPENCODE_AMBIENT_TOOLS.map((t) => [t, false])), ...(setup?.tools ?? {}), [`${MCP_NAME}_*`]: true, ...(dcp ? { compress: true } : {}) },
            ...(dcp ? { plugin: [pathToFileURL(dcp.path).href] } : {}),
            permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny', doom_loop: 'deny' },
            autoupdate: false,
            share: 'disabled',
          }),
        );

        const password = randomBytes(24).toString('base64url');
        const env: NodeJS.ProcessEnv = {
          // ripgrep's folder is added when rg is not on PATH, so OpenCode finds it instead of downloading a copy on every step.
          PATH: pathWithRipgrep(process.env.PATH, o.capabilities.runtimes.ripgrep?.path),
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local/share'),
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_STATE_HOME: join(home, '.local/state'),
          // Configuration comes only from the step's own folder: the project's opencode.json, .opencode/,
          // AGENTS.md, CLAUDE.md and .claude/skills (repository content when there is a workspace) are ignored.
          OPENCODE_CONFIG: join(configDir, 'opencode.json'),
          OPENCODE_CONFIG_DIR: configDir,
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_CLAUDE_CODE: '1',
          OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
          OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          // The server listens on loopback only, and still needs a password: no other local process may drive it.
          OPENCODE_SERVER_PASSWORD: password,
          // The Copilot sign-in reaches OpenCode in memory (OpenCode reads it instead of auth.json); nothing is written to disk.
          ...(copilot ? { OPENCODE_AUTH_CONTENT: JSON.stringify({ 'github-copilot': copilotAuth(key.value) }) } : {}),
          ...(chatgptSignIn ? { OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: chatgptSignIn }) } : {}),
          ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        };
        // The step's transcript goes to the run page live, with this step's secrets taken out first.
        sink = new TranscriptSink(runApi, ctx.info.attempt, [key.value, input.runToken, password, workspaceToken, ...(copilot ? Object.values(copilotAuth(key.value)).filter((v): v is string => typeof v === 'string') : []), ...(chatgptSignIn ? [chatgptSignIn.access, chatgptSignIn.refresh] : [])]);
        sink.put({ id: 'system', kind: 'system', text: system, at: Date.now() });
        if (setup?.command) sink.put({ id: 'command', kind: 'note', text: `The profile's command /${setup.command} runs after the input.`, at: Date.now() });
        proc = spawn(oc.path, ['serve', '--port', '0', '--hostname', '127.0.0.1', '--print-logs'], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let logs = '';
        // The whole OpenCode log (up to 4 MB) is kept so a failed step can save it: the step folder is deleted.
        const full: string[] = [];
        let fullSize = 0;
        const onLog = (b: Buffer) => {
          const t = b.toString();
          logs = (logs + t).slice(-4000);
          if (fullSize < 4 * 1024 * 1024) {
            full.push(t);
            fullSize += t.length;
          }
        };
        proc.stdout!.on('data', onLog);
        proc.stderr!.on('data', onLog);
        // OpenCode answers an internal failure with only a reference ("Check server logs"); the log line with
        // that reference has the cause. The full log is saved under ~/.azhi/logs/opencode/ and named in the error.
        const describe = (err: unknown): string => {
          const text = JSON.stringify(err).slice(0, 500);
          const ref = (err as { data?: { ref?: unknown } })?.data?.ref;
          const line = typeof ref === 'string' ? full.join('').split('\n').find((l) => l.includes(`ref=${ref}`)) : undefined;
          const cause = line ? (/error="([^"]*)"/.exec(line)?.[1] ?? line.slice(0, 400)) : undefined;
          const refused = copilot && /Unauthorized|\b401\b/i.test(`${cause ?? ''} ${text} ${logs}`)
            ? ` GitHub Copilot refused the saved sign-in (secret ${input.credential}). Run \`azhi copilot check\` to see why, then sign in again with \`azhi copilot login\` (or Sign in with GitHub Copilot on the Examples page) and start a new run.`
            : '';
          const plan = chatgpt && /Unauthorized|\b401\b/i.test(`${cause ?? ''} ${text} ${logs}`)
            ? ` OpenAI refused the ChatGPT sign-in (secret ${input.credential}). Run \`azhi chatgpt check\`, or sign in again with \`azhi chatgpt login\`, and start a new run.`
            : chatgpt && /usage.?limit|rate.?limit|\b429\b/i.test(`${cause ?? ''} ${text}`)
              ? ' The ChatGPT plan\'s usage limit is reached; it resets on its own (see your ChatGPT usage page). Start a new run after that.'
              : '';
          return `${cause ? `${cause} ` : ''}${text}${refused}${plan}${saveLog()}`;
        };
        let savedLog: string | undefined;
        const saveLog = (): string => {
          try {
            if (!savedLog) {
              const dir = join(process.env.AZHI_HOME ?? join(homedir(), '.azhi'), 'logs', 'opencode');
              mkdirSync(dir, { recursive: true });
              savedLog = join(dir, `${input.runId}-${input.nodeId}-${Date.now()}.log`);
              writeFileSync(savedLog, full.join(''), { mode: 0o600 });
            }
            return ` (OpenCode log: ${savedLog})`;
          } catch {
            return '';
          }
        };
        // A failed call to the OpenCode server is reported with the step and the server's last log lines.
        const step = async <T>(name: string, f: () => Promise<T>, idempotent = false): Promise<T> => {
          try {
            return await f();
          } catch (e) {
            if (e instanceof ApplicationFailure || e instanceof CancelledFailure) throw e;
            // OpenCode's server can drop a kept-alive connection after a long prompt; reads retry once.
            if (idempotent && /ECONNRESET|socket/i.test(String((e as { cause?: Error }).cause?.message ?? (e as Error).message))) return step(name, f, false);
            throw ApplicationFailure.create({ type: ErrorClass.transient, message: `opencode ${name}: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause?: Error }).cause!.message})` : ''}; ${logs.slice(-600)}${saveLog()}` });
          }
        };
        const url = await serverUrl(proc, 30_000);
        const client = createOpencodeClient({
          baseUrl: url,
          directory: project,
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
        } as Parameters<typeof createOpencodeClient>[0]);
        transcript = new OpencodeTranscript(client, sink);
        transcript.start();
        await step('bridge', () => waitForBridge(client, [MCP_NAME, ...Object.keys(setup?.mcp ?? {})], MCP_CONNECT_MS + 10_000));
        // The model must be one OpenCode offers for this provider; for Copilot that is the list your Copilot plan enables.
        const offered = (await step('providers', () => client.config.providers(), true)).data?.providers.find((p) => p.id === providerID);
        if (!offered?.models[input.model]) {
          const names = Object.keys(offered?.models ?? {}).sort();
          const where = copilot ? 'GitHub Copilot sign-in' : chatgpt ? 'ChatGPT plan' : `${providerID} provider`;
          throw ApplicationFailure.create({
            type: ErrorClass.invalidInput,
            nonRetryable: true,
            message: `model '${input.model}' is not available on this ${where}. ${names.length ? `Available: ${names.join(', ')}.` : 'OpenCode offers no models for it; check the sign-in.'} ${copilot ? 'Set AZHI_COPILOT_MODEL on the server or the profile\'s model name.' : chatgpt ? 'Set AZHI_CHATGPT_MODEL on the server or the profile\'s model name.' : 'Check the profile\'s model name.'}${saveLog()}`,
          });
        }
        const session = (await step('session', () => client.session.create({ body: { title: `${input.runId}/${input.nodeId}` } }))).data;
        if (!session) throw ApplicationFailure.create({ type: ErrorClass.transient, message: 'opencode did not create a session' });
        ctx.cancellationSignal.addEventListener('abort', () => void client.session.abort({ path: { id: session.id } }).catch(() => {}));
        transcript.follow(session.id);

        const readState = (): BridgeState => JSON.parse(readFileSync(stateFile, 'utf8'));
        let text = input.prompt;
        let reminders = 0;
        const deadline = started + input.timeoutMs;
        for (;;) {
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled');
          // With a profile setup, the Azhi system prompt is the agent's prompt and the first turn may be the profile's
          // command. The input goes first as its own message: OpenCode runs !`shell` found in a command after
          // substituting its arguments, so untrusted text must never be a command argument.
          if (setup?.command && reminders === 0) {
            const added = await step('input', () =>
              client.session.prompt({ path: { id: session.id }, body: { noReply: true, model: { providerID, modelID: input.model }, agent: setup.agent, parts: [{ type: 'text', text }] } }),
            );
            if (added.error) throw ApplicationFailure.create({ type: ErrorClass.transient, message: `opencode input: ${describe(added.error)}` });
          }
          // When the bridge stops the node (budget, repairs, repeated failures), end the turn now.
          const watch = setInterval(() => {
            try {
              if (readState().stopped) void client.session.abort({ path: { id: session.id } }).catch(() => {});
            } catch {
              /* state file mid-write */
            }
          }, 300);
          const r = await step('prompt', () =>
            setup?.command && reminders === 0
              ? client.session.command({ path: { id: session.id }, body: { command: setup.command, arguments: '', agent: setup.agent, model: `${providerID}/${input.model}` } })
              : client.session.prompt({
                  path: { id: session.id },
                  body: { model: { providerID, modelID: input.model }, ...(setup ? { agent: setup.agent } : { system }), parts: [{ type: 'text', text }] },
                }),
          ).finally(() => clearInterval(watch));
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled; opencode session aborted');
          const err = r.error ?? r.data?.info.error;
          const state = readState();
          if (state.stopped) return await finish(client, session.id, { error: state.stopped }, state);
          if (state.output !== undefined) return await finish(client, session.id, { output: state.output }, state);
          if (err) {
            const message = describe(err);
            return await finish(client, session.id, { error: { class: /auth/i.test(message) ? ErrorClass.authorization : ErrorClass.transient, message: `opencode: ${message}` } }, state);
          }
          if (++reminders > MAX_REPAIRS || Date.now() > deadline) {
            return await finish(client, session.id, { error: { class: ErrorClass.contractViolation, message: `the agent did not call ${SUBMIT_TOOL} after ${MAX_REPAIRS} reminders` } }, state);
          }
          text = `Return your result by calling ${MCP_NAME}_${SUBMIT_TOOL}.`;
        }

        async function finish(client: ReturnType<typeof createOpencodeClient>, sessionId: string, r: Pick<HarnessResult, 'output' | 'error'>, state: BridgeState): Promise<HarnessResult> {
          // OpenCode reports tokens per assistant message; sum every message of the session.
          const messages = ((await step('messages', () => client.session.messages({ path: { id: sessionId } }), true)).data ?? []) as Array<{ info: { role: string; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } } }>;
          transcript?.backfill(messages as never);
          if (r.error) sink?.put({ id: 'azhi-result', kind: 'error', text: `${r.error.class}: ${r.error.message}`, at: Date.now() });
          const assistant = messages.filter((m) => m.info.role === 'assistant' && m.info.tokens);
          const sum = (f: (t: NonNullable<(typeof assistant)[number]['info']['tokens']>) => number) => (assistant.length ? assistant.reduce((n, m) => n + f(m.info.tokens!), 0) : null);
          return {
            ...r,
            usage: {
              input_tokens: sum((t) => t.input),
              output_tokens: sum((t) => t.output),
              cache_read_tokens: sum((t) => t.cache.read),
              cache_write_tokens: sum((t) => t.cache.write),
              reasoning_tokens: sum((t) => t.reasoning),
            },
            model_calls: assistant.length,
            tool_calls: state.toolCalls,
            repairs: state.repairs,
            duration_ms: Date.now() - started,
            harness: { name: 'opencode', version: oc!.version },
          };
        }
      } finally {
        clearInterval(hb);
        transcript?.stop();
        await sink?.close();
        if (proc) await stopProcess(proc);
        if (chatgptSignIn) await keepRenewedSignIn(runApi, input.credential, home, chatgptSignIn);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * When a step outlasts the ChatGPT access token, OpenCode renews it and writes the new tokens to the step's
 * own auth.json. OpenAI rotates the refresh token, so the renewed sign-in goes back to the server; otherwise
 * the next step would start from a dead one.
 */
export async function keepRenewedSignIn(runApi: ApiClient, credential: string, home: string, given: ChatgptAuth) {
  try {
    const file = join(home, '.local/share/opencode/auth.json');
    const renewed = chatgptAuth(readFileSync(file, 'utf8'));
    if (renewed && renewed.refresh !== given.refresh) await runApi.post(`/v1/gateway/credentials/${encodeURIComponent(credential)}/renewed`, { value: JSON.stringify({ openai: renewed }) });
  } catch {
    // No renewal happened (no file), or the server is unreachable: the next step's sign-in check will say so.
  }
}

function serverUrl(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(ApplicationFailure.create({ type: ErrorClass.transient, message: `opencode serve did not start: ${out.slice(-300)}` })), timeoutMs);
    const scan = (b: Buffer) => {
      out += b.toString();
      const m = /https?:\/\/127\.0\.0\.1:\d+/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout!.on('data', scan);
    proc.stderr!.on('data', scan);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(ApplicationFailure.create({ type: ErrorClass.transient, message: `opencode serve exited (${code}): ${out.slice(-300)}` }));
    });
  });
}

/** How long OpenCode may take to start the bridge and each MCP server. */
const MCP_CONNECT_MS = 120_000;

/** Waits until the gateway bridge and the profile's MCP servers are connected. */
async function waitForBridge(client: ReturnType<typeof createOpencodeClient>, names: string[], timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = ((await client.mcp.status()).data ?? {}) as Record<string, { status: string; error?: string }>;
    if (names.every((n) => s[n]?.status === 'connected')) return;
    const bad = names.find((n) => s[n]?.status === 'failed') ?? (Date.now() > end ? names.find((n) => s[n]?.status !== 'connected') : undefined);
    if (bad) {
      const what = bad === MCP_NAME ? 'gateway bridge' : `MCP server ${bad}`;
      throw ApplicationFailure.create({ type: ErrorClass.transient, message: `${what} did not connect to opencode: ${JSON.stringify(s[bad] ?? 'missing')}` });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function stopProcess(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  try {
    killTree(proc.pid!, 'SIGTERM');
  } catch {
    return;
  }
  const t = setTimeout(() => {
    try {
      killTree(proc.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000);
  await exited;
  clearTimeout(t);
}
