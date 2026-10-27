import { CancelledFailure, Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeState } from '../agents/gateway-mcp.js';
import { MAX_REPAIRS } from '../agents/model-agent.js';
import { SUBMIT_TOOL } from '../agents/providers.js';
import { ErrorClass } from '../lib/errors.js';
import { killTree } from '../lib/process.js';
import { ApiClient } from './api-client.js';
import type { WorkerCapabilities } from './capabilities.js';
import type { HarnessInput, HarnessResult } from './harness-activity.js';
import { preparePackage, type ScriptWorkerOptions } from './script-activity.js';
import { TranscriptSink } from './transcript.js';

/**
 * The Codex CLI adapter (spec section 9). `codex exec` runs headless with an isolated CODEX_HOME
 * whose config.toml names the model endpoint (Responses API), the Azhi gateway bridge as its only
 * MCP server, and a read-only sandbox with approvals off. The key goes in the child's environment,
 * never into the config or history. Codex's own shell tool cannot be removed, only sandboxed, so
 * the executor declares its ambient tools as uncontrolled and a node can refuse that with
 * `requires.enforced_restrictions`. Output returns through submit_output, as for OpenCode.
 */
const MCP_NAME = 'azhi';
const KEY_VAR = 'AZHI_PROVIDER_KEY';

/** A TOML basic string. JSON's escapes are a subset of TOML's, so JSON.stringify is a valid writer. */
const str = (v: string) => JSON.stringify(v);

export function codexConfig(input: HarnessInput, bridge: { command: string; args: string[]; env: Record<string, string> }): string {
  const lines = [
    `model = ${str(input.model)}`,
    'model_provider = "azhi"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    `developer_instructions = ${str(input.system)}`,
    '',
    '[model_providers.azhi]',
    'name = "azhi"',
    `base_url = ${str(`${input.providerUrl.replace(/\/$/, '')}/v1`)}`,
    `env_key = ${str(KEY_VAR)}`,
    'wire_api = "responses"',
    '',
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${str(bridge.command)}`,
    `args = [${bridge.args.map(str).join(', ')}]`,
    'startup_timeout_sec = 60',
    `[mcp_servers.${MCP_NAME}.env]`,
    ...Object.entries(bridge.env).map(([k, v]) => `${k} = ${str(v)}`),
    '',
  ];
  return lines.join('\n');
}

export async function runCodex(o: ScriptWorkerOptions & { capabilities: WorkerCapabilities }, input: HarnessInput): Promise<HarnessResult> {
  const rt = o.capabilities.runtimes.codex;
  if (!rt) throw ApplicationFailure.create({ type: ErrorClass.unsupportedCapability, message: 'this worker has no Codex CLI', nonRetryable: true });
  await preparePackage(o, input.packageHash);
  const ctx = Context.current();
  const runApi = new ApiClient(o.api.baseUrl, input.runToken);
  const key = await runApi.get<{ value: string }>(`/v1/gateway/credentials/${encodeURIComponent(input.credential)}`).catch((e) => {
    throw ApplicationFailure.create({ type: ErrorClass.authorization, message: `provider credential ${input.credential}: ${(e as Error).message}`, nonRetryable: true });
  });

  const root = mkdtempSync(join(tmpdir(), 'azhi-codex-'));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const project = join(root, 'project');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(project);
  const stateFile = join(root, 'bridge-state.json');
  const bin = fileURLToPath(new URL('../../bin/azhi.js', import.meta.url));
  writeFileSync(
    join(codexHome, 'config.toml'),
    codexConfig(input, {
      command: process.execPath,
      args: [bin, 'gateway-mcp'],
      env: {
        AZHI_URL: o.api.baseUrl,
        AZHI_RUN_TOKEN: input.runToken,
        AZHI_BRIDGE_TOOLS: JSON.stringify(input.tools),
        AZHI_BRIDGE_OUTPUT_SCHEMA: JSON.stringify(input.outputSchema),
        AZHI_BRIDGE_STATE: stateFile,
        ...(input.maxToolCalls !== undefined ? { AZHI_BRIDGE_MAX_TOOL_CALLS: String(input.maxToolCalls) } : {}),
      },
    }),
  );
  const readState = (): BridgeState => JSON.parse(readFileSync(stateFile, 'utf8'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    [KEY_VAR]: key.value,
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };

  // The step's transcript goes to the run page live, with this step's secrets taken out first.
  const sink = new TranscriptSink(runApi, ctx.info.attempt, [key.value, input.runToken]);
  sink.put({ id: 'system', kind: 'system', text: input.system, at: Date.now() });
  let prompts = 0;

  const started = Date.now();
  const totals = { input: null as number | null, cached: null as number | null, output: null as number | null, reasoning: null as number | null, turns: 0 };
  const add = (k: 'input' | 'cached' | 'output' | 'reasoning', n: unknown) => {
    if (typeof n === 'number') totals[k] = (totals[k] ?? 0) + n;
  };
  let proc: ChildProcess | undefined;
  const stop = () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        killTree(proc.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  const onCancel = () => stop();
  ctx.cancellationSignal.addEventListener('abort', onCancel);
  const hb = setInterval(() => ctx.heartbeat(), 5000);
  // When the bridge stops the node (budget, repairs, repeated failures), end the turn now.
  const watch = setInterval(() => {
    try {
      if (readState().stopped) stop();
    } catch {
      /* state file not written yet, or mid-write */
    }
  }, 300);

  const done = (r: Pick<HarnessResult, 'output' | 'error'>, calls: { tool: number; repairs: number }): HarnessResult => {
    if (r.error) sink.put({ id: 'azhi-result', kind: 'error', text: `${r.error.class}: ${r.error.message}`, at: Date.now() });
    return finished(r, calls);
  };
  const finished = (r: Pick<HarnessResult, 'output' | 'error'>, calls: { tool: number; repairs: number }): HarnessResult => ({
    ...r,
    usage: {
      // Codex counts cached tokens inside input_tokens; the usage records keep them apart.
      input_tokens: totals.input === null ? null : Math.max(0, totals.input - (totals.cached ?? 0)),
      output_tokens: totals.output,
      cache_read_tokens: totals.cached,
      cache_write_tokens: null,
      reasoning_tokens: totals.reasoning,
    },
    model_calls: totals.turns,
    tool_calls: calls.tool,
    repairs: calls.repairs,
    duration_ms: Date.now() - started,
    harness: { name: 'codex', version: rt.version },
  });

  /** One `codex exec` (or `exec resume`) run: the prompt goes in on stdin, events come back as JSON lines. */
  const exec = (prompt: string, thread?: string) =>
    new Promise<{ thread?: string; failed?: string; code: number | null; logs: string }>((resolve, reject) => {
      sink.put({ id: `prompt-${++prompts}`, kind: 'user', text: prompt, at: Date.now() });
      const args = ['exec', ...(thread ? ['resume'] : []), '--json', '--skip-git-repo-check', ...(thread ? [thread] : []), '-'];
      const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(rt.path);
      const p = spawn(rt.path, args, { cwd: project, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: win, windowsHide: true });
      proc = p;
      let id = thread;
      let failed: string | undefined;
      let logs = '';
      let buf = '';
      p.stdout!.on('data', (b: Buffer) => {
        buf += b.toString();
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const e = JSON.parse(line) as { type: string; thread_id?: string; usage?: Record<string, number>; message?: string; error?: { message?: string } };
            if (e.type === 'thread.started' && e.thread_id) id = e.thread_id;
            if (e.type === 'turn.completed') {
              totals.turns++;
              add('input', e.usage?.input_tokens);
              add('cached', e.usage?.cached_input_tokens);
              add('output', e.usage?.output_tokens);
              add('reasoning', e.usage?.reasoning_output_tokens);
            }
            if (e.type === 'turn.failed') failed = e.error?.message ?? 'turn failed';
            if (e.type === 'turn.completed') sink.put({ id: `turn-${prompts}-${totals.turns}`, kind: 'step', tokens: { input: e.usage?.input_tokens, output: e.usage?.output_tokens, reasoning: e.usage?.reasoning_output_tokens, cache_read: e.usage?.cached_input_tokens }, at: Date.now() });
            if (e.type.startsWith('item.')) codexItem(sink, (e as { item?: Record<string, any> }).item);
            if (e.type === 'error' && e.message) failed = e.message;
          } catch {
            /* not an event */
          }
        }
      });
      p.stderr!.on('data', (b: Buffer) => (logs = (logs + b.toString()).slice(-2000)));
      p.once('error', (e) => reject(ApplicationFailure.create({ type: ErrorClass.transient, message: `codex did not start: ${e.message}` })));
      p.once('exit', (code) => resolve({ thread: id, failed, code, logs }));
      p.stdin!.on('error', () => {});
      p.stdin!.end(prompt);
    });

  try {
    let thread: string | undefined;
    let prompt = input.prompt;
    let reminders = 0;
    const deadline = started + input.timeoutMs;
    for (;;) {
      if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled');
      const r = await exec(prompt, thread);
      if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled; codex stopped');
      thread = r.thread;
      let state: BridgeState | undefined;
      try {
        state = readState();
      } catch {
        /* the bridge never started */
      }
      const calls = { tool: state?.toolCalls ?? 0, repairs: state?.repairs ?? 0 };
      if (state?.stopped) return done({ error: state.stopped }, calls);
      if (state?.output !== undefined) return done({ output: state.output }, calls);
      if (r.failed || r.code) {
        const message = r.failed ?? `codex exited with ${r.code}: ${r.logs.slice(-400)}`;
        return done({ error: { class: /auth|api key|401|403|incorrect/i.test(message) ? ErrorClass.authorization : ErrorClass.transient, message: `codex: ${message.slice(0, 500)}` } }, calls);
      }
      if (++reminders > MAX_REPAIRS || Date.now() > deadline || !thread) {
        return done({ error: { class: ErrorClass.contractViolation, message: `the agent did not call ${SUBMIT_TOOL} after ${MAX_REPAIRS} reminders` } }, calls);
      }
      prompt = `Return your result by calling the ${MCP_NAME} MCP tool ${SUBMIT_TOOL}.`;
    }
  } finally {
    clearInterval(hb);
    clearInterval(watch);
    ctx.cancellationSignal.removeEventListener('abort', onCancel);
    stop();
    await sink.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A Codex thread item (agent message, reasoning, MCP tool call, command, error) as a transcript entry. */
function codexItem(sink: TranscriptSink, item: Record<string, any> | undefined) {
  if (!item?.id) return;
  const id = `item-${item.id}`;
  switch (item.type) {
    case 'agent_message':
      if (item.text) sink.put({ id, kind: 'assistant', text: item.text, at: Date.now() });
      return;
    case 'reasoning':
      if (item.text) sink.put({ id, kind: 'reasoning', text: item.text, at: Date.now() });
      return;
    case 'mcp_tool_call': {
      const status = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'error' : 'running';
      const result = item.result?.content ? (item.result.content as any[]).map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n') : item.result !== undefined && item.result !== null ? JSON.stringify(item.result) : undefined;
      sink.put({ id, kind: 'tool', tool: `${item.server ? `${item.server}_` : ''}${item.tool ?? 'tool'}`, status, input: item.arguments, ...(status === 'error' ? { error: item.error?.message ?? 'failed' } : result !== undefined ? { output: result } : {}), at: Date.now() });
      return;
    }
    case 'command_execution':
      sink.put({ id, kind: 'tool', tool: 'shell', status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'error' : 'running', input: { command: item.command }, ...(item.aggregated_output ? { output: item.aggregated_output } : {}), at: Date.now() });
      return;
    case 'error':
      sink.put({ id, kind: 'error', text: item.message ?? 'error', at: Date.now() });
      return;
  }
}
