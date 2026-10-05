import { CancelledFailure, Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeState, BridgeTool } from '../agents/gateway-mcp.js';
import { MAX_REPAIRS } from '../agents/model-agent.js';
import { SUBMIT_TOOL } from '../agents/providers.js';
import { ErrorClass } from '../lib/errors.js';
import { killTree } from '../lib/process.js';
import { ApiClient } from './api-client.js';
import type { WorkerCapabilities } from './capabilities.js';
import { runClaudeAgentSdk } from './harness-claude.js';
import { runCodex } from './harness-codex.js';
import { readProfileHarness, writeOpencodeSetup } from './opencode-setup.js';
import { preparePackage, type ScriptWorkerOptions } from './script-activity.js';
import { cloneWorkspace, isolatedGitEnv, type WorkspaceSpec } from './workspace.js';

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
  provider?: 'anthropic' | 'openai' | 'github-copilot';
  runToken: string;
  /** Workspace secret holding the provider key; fetched with the run token, never put in history. */
  credential: string;
  providerUrl: string;
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
export function copilotAuth(value: string): { type: 'oauth'; refresh: string; access: string; expires: number; enterpriseUrl?: string } {
  const v = value.trim();
  if (v.startsWith('{')) {
    try {
      const j = JSON.parse(v);
      const e = j['github-copilot'] ?? j;
      if (typeof e?.refresh === 'string' && e.refresh) return { type: 'oauth', refresh: e.refresh, access: e.access ?? e.refresh, expires: 0, ...(e.enterpriseUrl ? { enterpriseUrl: String(e.enterpriseUrl) } : {}) };
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
      const bin = fileURLToPath(new URL('../../bin/azhi.js', import.meta.url));
      const started = Date.now();
      const hb = setInterval(() => ctx.heartbeat(), 5000);
      let proc: ChildProcess | undefined;
      try {
        // The step's directory: a fresh checkout when the node has a workspace, else an empty folder.
        let project = join(root, 'project');
        if (input.workspace) {
          const token = input.workspace.credential
            ? (
                await runApi.get<{ value: string }>(`/v1/gateway/credentials/${encodeURIComponent(input.workspace.credential)}`).catch((e) => {
                  throw ApplicationFailure.create({ type: ErrorClass.authorization, message: `workspace credential ${input.workspace!.credential}: ${(e as Error).message}`, nonRetryable: true });
                })
              ).value
            : undefined;
          project = (await cloneWorkspace(input.workspace, { root, home, token, timeoutMs: Math.min(input.timeoutMs, 600_000), signal: ctx.cancellationSignal })).dir;
        } else {
          mkdirSync(project);
        }
        const copilot = input.provider === 'github-copilot';
        const providerID = copilot ? 'github-copilot' : 'anthropic';
        const setup = profileHarness ? writeOpencodeSetup(profileHarness, { pkgDir: pkg.dir, configDir, system: input.system, gitEnv: isolatedGitEnv(home), workspace: input.workspace ? project : undefined }) : undefined;
        writeFileSync(
          join(configDir, 'opencode.json'),
          JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            provider: copilot
              ? {
                  // Copilot's endpoint and model list are OpenCode's own; only a stand-in or proxy URL is set here.
                  'github-copilot': input.providerUrl
                    ? { options: { baseURL: input.providerUrl.replace(/\/$/, '') }, models: { [input.model]: { name: input.model, tool_call: true, limit: { context: 200000, output: 8192 } } } }
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
                command: [process.execPath, bin, 'gateway-mcp'],
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
            tools: { '*': false, ...Object.fromEntries(OPENCODE_AMBIENT_TOOLS.map((t) => [t, false])), ...(setup?.tools ?? {}), [`${MCP_NAME}_*`]: true },
            permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny', doom_loop: 'deny' },
            autoupdate: false,
            share: 'disabled',
          }),
        );

        const password = randomBytes(24).toString('base64url');
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
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
          ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        };
        proc = spawn(oc.path, ['serve', '--port', '0', '--hostname', '127.0.0.1', '--print-logs'], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let logs = '';
        proc.stdout!.on('data', (b: Buffer) => (logs = (logs + b.toString()).slice(-4000)));
        proc.stderr!.on('data', (b: Buffer) => (logs = (logs + b.toString()).slice(-4000)));
        // A failed call to the OpenCode server is reported with the step and the server's last log lines.
        const step = async <T>(name: string, f: () => Promise<T>, idempotent = false): Promise<T> => {
          try {
            return await f();
          } catch (e) {
            if (e instanceof ApplicationFailure || e instanceof CancelledFailure) throw e;
            // OpenCode's server can drop a kept-alive connection after a long prompt; reads retry once.
            if (idempotent && /ECONNRESET|socket/i.test(String((e as { cause?: Error }).cause?.message ?? (e as Error).message))) return step(name, f, false);
            throw ApplicationFailure.create({ type: ErrorClass.transient, message: `opencode ${name}: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause?: Error }).cause!.message})` : ''}; ${logs.slice(-600)}` });
          }
        };
        const url = await serverUrl(proc, 30_000);
        const client = createOpencodeClient({
          baseUrl: url,
          directory: project,
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
        } as Parameters<typeof createOpencodeClient>[0]);
        await step('bridge', () => waitForBridge(client, [MCP_NAME, ...Object.keys(setup?.mcp ?? {})], 15_000));
        const session = (await step('session', () => client.session.create({ body: { title: `${input.runId}/${input.nodeId}` } }))).data;
        if (!session) throw ApplicationFailure.create({ type: ErrorClass.transient, message: 'opencode did not create a session' });
        ctx.cancellationSignal.addEventListener('abort', () => void client.session.abort({ path: { id: session.id } }).catch(() => {}));

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
            if (added.error) throw ApplicationFailure.create({ type: ErrorClass.transient, message: `opencode input: ${JSON.stringify(added.error).slice(0, 300)}` });
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
                  body: { model: { providerID, modelID: input.model }, ...(setup ? { agent: setup.agent } : { system: input.system }), parts: [{ type: 'text', text }] },
                }),
          ).finally(() => clearInterval(watch));
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled; opencode session aborted');
          const err = r.error ?? r.data?.info.error;
          const state = readState();
          if (state.stopped) return await finish(client, session.id, { error: state.stopped }, state);
          if (state.output !== undefined) return await finish(client, session.id, { output: state.output }, state);
          if (err) {
            const message = JSON.stringify(err).slice(0, 500);
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
        if (proc) await stopProcess(proc);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
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
