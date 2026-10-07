import { CancelledFailure, Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeState } from '../agents/gateway-mcp.js';
import { MAX_REPAIRS } from '../agents/model-agent.js';
import { SUBMIT_TOOL } from '../agents/providers.js';
import { ErrorClass } from '../lib/errors.js';
import { ApiClient } from './api-client.js';
import type { WorkerCapabilities } from './capabilities.js';
import type { HarnessInput, HarnessResult } from './harness-activity.js';
import { preparePackage, type ScriptWorkerOptions } from './script-activity.js';
import { BlockTranscript, TranscriptSink } from './transcript.js';

/**
 * The Claude Agent SDK adapter (spec section 9). The SDK drives the Claude Code runtime headless
 * with an isolated HOME and no settings files, its built-in tools switched off, and only the Azhi
 * gateway bridge (stdio MCP) allowed, in `dontAsk` mode so nothing else can be approved. The
 * model's key and endpoint are passed through the child's environment, never into history. Output
 * comes back through submit_output and is validated by the bridge, as for OpenCode.
 */
const MCP_NAME = 'azhi';
// Claude Code counts a turn per model call; this bounds a runaway tool loop (the bridge enforces tool budgets).
const MAX_TURNS = 40;

type Totals = HarnessResult['usage'] & { turns: number };

export async function runClaudeAgentSdk(o: ScriptWorkerOptions & { capabilities: WorkerCapabilities }, input: HarnessInput): Promise<HarnessResult> {
  const rt = o.capabilities.runtimes['claude-agent-sdk'];
  if (!rt) throw ApplicationFailure.create({ type: ErrorClass.unsupportedCapability, message: 'this worker has no Claude Agent SDK runtime', nonRetryable: true });
  await preparePackage(o, input.packageHash);
  const ctx = Context.current();
  const runApi = new ApiClient(o.api.baseUrl, input.runToken);
  const key = await runApi.get<{ value: string }>(`/v1/gateway/credentials/${encodeURIComponent(input.credential)}`).catch((e) => {
    throw ApplicationFailure.create({ type: ErrorClass.authorization, message: `provider credential ${input.credential}: ${(e as Error).message}`, nonRetryable: true });
  });
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const root = mkdtempSync(join(tmpdir(), 'azhi-claude-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  const stateFile = join(root, 'bridge-state.json');
  const bin = fileURLToPath(new URL('../../bin/azhi.js', import.meta.url));
  const readState = (): BridgeState => JSON.parse(readFileSync(stateFile, 'utf8'));

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: input.providerUrl.replace(/\/$/, ''),
    ANTHROPIC_API_KEY: key.value,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const bridge = {
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
  };

  // The step's transcript goes to the run page live, with this step's secrets taken out first.
  const sink = new TranscriptSink(runApi, ctx.info.attempt, [key.value, input.runToken]);
  const blocks = new BlockTranscript(sink);
  sink.put({ id: 'system', kind: 'system', text: input.system, at: Date.now() });

  const started = Date.now();
  const totals: Totals = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, turns: 0 };
  const add = (k: keyof Omit<Totals, 'turns'>, n: unknown) => {
    if (typeof n === 'number') totals[k] = (totals[k] ?? 0) + n;
  };
  const abort = new AbortController();
  const onCancel = () => abort.abort();
  ctx.cancellationSignal.addEventListener('abort', onCancel);
  const hb = setInterval(() => ctx.heartbeat(), 5000);
  // When the bridge stops the node (budget, repairs, repeated failures), end the turn now.
  const watch = setInterval(() => {
    try {
      if (readState().stopped) abort.abort();
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
    usage: { input_tokens: totals.input_tokens, output_tokens: totals.output_tokens, cache_read_tokens: totals.cache_read_tokens, cache_write_tokens: totals.cache_write_tokens, reasoning_tokens: totals.reasoning_tokens },
    model_calls: totals.turns,
    tool_calls: calls.tool,
    repairs: calls.repairs,
    duration_ms: Date.now() - started,
    harness: { name: 'claude-agent-sdk', version: rt['version'] },
  });

  try {
    let sessionId: string | undefined;
    let prompt = input.prompt;
    let reminders = 0;
    const deadline = started + input.timeoutMs;
    for (;;) {
      if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled');
      let result: Record<string, any> | undefined;
      let failure: string | undefined;
      blocks.user(prompt);
      try {
        const q = query({
          prompt,
          options: {
            model: input.model,
            systemPrompt: input.system,
            cwd: project,
            env,
            abortController: abort,
            // No built-in tools at all; only the gateway bridge, and nothing else can be approved.
            tools: [],
            allowedTools: [`mcp__${MCP_NAME}__*`],
            permissionMode: 'dontAsk',
            mcpServers: { [MCP_NAME]: bridge },
            strictMcpConfig: true,
            settingSources: [],
            maxTurns: MAX_TURNS,
            ...(sessionId ? { resume: sessionId } : {}),
            ...(process.env.AZHI_CLAUDE_CODE_BIN ? { pathToClaudeCodeExecutable: process.env.AZHI_CLAUDE_CODE_BIN } : {}),
          },
        });
        for await (const m of q as AsyncIterable<Record<string, any>>) {
          if (m.session_id) sessionId = m.session_id;
          if (m.type === 'result') result = m;
          if (m.type === 'assistant') blocks.assistant(m.message?.content, m.message?.model);
          if (m.type === 'user' && Array.isArray(m.message?.content)) blocks.user(m.message.content);
          if (m.type === 'result') sink.put({ id: `result-${reminders}`, kind: 'step', text: m.subtype, tokens: { input: m.usage?.input_tokens, output: m.usage?.output_tokens, cache_read: m.usage?.cache_read_input_tokens, cache_write: m.usage?.cache_creation_input_tokens }, at: Date.now() });
        }
      } catch (e) {
        if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled; Claude Agent SDK session aborted');
        // An abort the bridge asked for is not a failure; its state says why the node stopped.
        if (!abort.signal.aborted) failure = (e as Error).message;
      }
      if (ctx.cancellationSignal.aborted) throw new CancelledFailure('harness cancelled; Claude Agent SDK session aborted');
      if (result) {
        const u = result.usage ?? {};
        add('input_tokens', u.input_tokens);
        add('output_tokens', u.output_tokens);
        add('cache_read_tokens', u.cache_read_input_tokens);
        add('cache_write_tokens', u.cache_creation_input_tokens);
        add('reasoning_tokens', u.output_tokens_details?.thinking_tokens);
        totals.turns += typeof result.num_turns === 'number' ? result.num_turns : 0;
      }
      let state: BridgeState | undefined;
      try {
        state = readState();
      } catch {
        /* the bridge never started */
      }
      const calls = { tool: state?.toolCalls ?? 0, repairs: state?.repairs ?? 0 };
      if (state?.stopped) return done({ error: state.stopped }, calls);
      if (state?.output !== undefined) return done({ output: state.output }, calls);
      if (failure || result?.is_error) {
        const message = failure ?? String(result?.result ?? result?.subtype ?? 'error');
        return done({ error: { class: /auth|api key|401|403/i.test(message) ? ErrorClass.authorization : ErrorClass.transient, message: `claude-agent-sdk: ${message.slice(0, 500)}` } }, calls);
      }
      if (++reminders > MAX_REPAIRS || Date.now() > deadline) {
        return done({ error: { class: ErrorClass.contractViolation, message: `the agent did not call ${SUBMIT_TOOL} after ${MAX_REPAIRS} reminders` } }, calls);
      }
      prompt = `Return your result by calling mcp__${MCP_NAME}__${SUBMIT_TOOL}.`;
    }
  } finally {
    clearInterval(hb);
    clearInterval(watch);
    ctx.cancellationSignal.removeEventListener('abort', onCancel);
    await sink.close();
    rmSync(root, { recursive: true, force: true });
  }
}
