import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isArtifactHandle } from '../artifacts/store.js';
import { callTool } from '../gateway/gateway.js';
import { CONTEXT_CEILING_BYTES } from '../gateway/projection.js';
import { canonicalJson, sha256 } from '../lib/hash.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { byteSize } from '../lib/json.js';
import { loadToolRevision } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { packageFile } from '../server/packages.js';
import { resolveSecret } from '../server/secrets.js';
import { profilePath } from '../compiler/compile.js';
import { EXECUTORS } from '../executors/capabilities.js';
import { citationIds } from '../runtime/report.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_TURNS, parseProfile, type AgentProfile } from './profile.js';
import { anthropicProvider, openaiProvider, PROVIDER_DEFAULTS, scriptedProvider, SUBMIT_TOOL, toolName, type Block, type Message, type ModelProvider, type ModelTool, type Usage } from './providers.js';

/**
 * The built-in model agent (spec section 9): a platform-owned tool loop. Each model turn is one
 * activity; the transcript lives in the artifact store between turns, so a crash resumes at the
 * last completed turn. Every tool call goes through the gateway, every turn writes a context
 * manifest and a usage record, and the output is validated against the node's schema.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);

export const MAX_REPAIRS = 2;
export const MAX_REPEATED_FAILURES = 2;

const PLATFORM_RULES = `You are one agent node in an Azhi Flow workflow.
- Numbers in your input come from scripts and tools and are authoritative. Quote them; never recalculate or change them.
- Use only the tools provided. Every call goes through a governed gateway that may refuse it.
- When you are done, call ${SUBMIT_TOOL} exactly once with a result that matches its schema.
- If the evidence is insufficient, say so in your result instead of guessing.
- Cite retrieved excerpts by their chunk id.`;

export interface ManifestItem {
  kind: 'instructions' | 'profile' | 'output_schema' | 'tool_schema' | 'input' | 'chunk' | 'tool_result' | 'repair';
  source: string;
  reason: string;
  tokens: number;
  content_hash: string;
  content?: string;
}

export interface AgentTool {
  ref: string;
  effect: string;
  safeForTainted: boolean;
  revision?: number;
}

export interface Chunk {
  id: string;
  dataset: string;
  revision: number;
  heading: string;
  text: string;
}

interface Transcript {
  profile: string;
  profilePath: string;
  provider: AgentProfile['model']['provider'];
  model: string;
  messages: Message[];
  system: string;
  tools: ModelTool[];
  toolRefs: Record<string, string>;
  outputSchema: Record<string, unknown>;
  /** The output schema was not an object, so submit_output takes `{ value }`. */
  wrapped: boolean;
  items: ManifestItem[];
  /** Chunk IDs the agent was shown; citing anything else is a contract violation. */
  chunkIds?: string[];
}

export interface AgentState {
  transcript: string;
  turn: number;
  toolCalls: number;
  /** Sum of reported output tokens; null once any turn's usage is unknown. */
  outputTokens: number | null;
  /** Sum of estimated cost; null when pricing or usage is unknown. */
  cost: number | null;
  repairs: number;
  failures: Record<string, number>;
}

export interface AgentBeginInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  packageHash: string;
  profile: string;
  outputSchema: Record<string, unknown>;
  tools: AgentTool[];
  input: unknown;
  /** Upstream nodes the input came from, for the manifest. */
  inputSources: string[];
  chunks?: Chunk[];
  /** Datasets the context builder retrieves from, pinned in the run snapshot. */
  datasets?: Array<{ ref: string; revision: number }>;
  principal?: { userId: string; role: string };
}

export interface AgentTurnInput {
  runId: string;
  workspaceId: string;
  nodeId: string;
  packageHash: string;
  tools: AgentTool[];
  tainted?: string;
  budget?: { max_output_tokens?: number; max_tool_calls?: number; max_cost_usd?: number };
  /** Test runs: write tools return a mock receipt instead of executing. */
  mockWrites?: boolean;
  state: AgentState;
}

export interface AgentTurnResult {
  state: AgentState;
  done: boolean;
  output?: unknown;
  usageKnown: boolean;
}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

function item(kind: ManifestItem['kind'], source: string, reason: string, content: string, storeContent: boolean): ManifestItem {
  return { kind, source, reason, tokens: estimateTokens(content), content_hash: `sha256:${sha256(content)}`, ...(storeContent ? { content } : {}) };
}

async function loadProfile(ctx: AppContext, workspaceId: string, packageHash: string, profile: string): Promise<{ path: string; profile: AgentProfile; text: string }> {
  const path = profilePath(profile);
  const text = (await packageFile(ctx, workspaceId, packageHash, path)).toString('utf8');
  return { path, profile: parseProfile(text, path), text };
}

export function resolveModelName(ctx: AppContext, profile: AgentProfile): string {
  if (profile.model.provider === 'scripted') return 'scripted';
  const name = profile.model.name ?? 'default';
  if (name !== 'default') return name;
  const d = PROVIDER_DEFAULTS[profile.model.provider];
  const model = d.model(ctx.settings);
  if (!model) throw new AzhiError(ErrorClass.unsupportedCapability, `the profile uses the default ${profile.model.provider} model but ${d.modelEnv} is not set on the server`);
  return model;
}

async function providerFor(ctx: AppContext, workspaceId: string, profile: AgentProfile): Promise<ModelProvider> {
  if (profile.model.provider === 'scripted') return scriptedProvider(profile.script ?? []);
  const provider = profile.model.provider;
  const d = PROVIDER_DEFAULTS[provider];
  const credential = profile.model.credential ?? d.credential;
  const key = await resolveSecret(ctx, workspaceId, credential);
  if (!key) throw new AzhiError(ErrorClass.authorization, `credential '${credential}' for the ${provider} provider is not set`);
  const make = provider === 'openai' ? openaiProvider : anthropicProvider;
  return make({ apiUrl: d.apiUrl(ctx.settings), apiKey: key.value });
}

/** Replaces artifact handles and deferred refs in the agent input with their content. */
function materialise(ctx: AppContext, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => materialise(ctx, x));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, any>;
  if (isArtifactHandle(o)) return JSON.parse(ctx.artifacts.get(o.$artifact.hash)?.toString('utf8') ?? 'null');
  if (o.$artifact_path && Object.keys(o).length === 1) {
    let cur: any = JSON.parse(ctx.artifacts.get(o.$artifact_path.hash)?.toString('utf8') ?? 'null');
    for (const seg of o.$artifact_path.path as string[]) cur = cur?.[seg];
    return cur;
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, materialise(ctx, x)]));
}

function saveTranscript(ctx: AppContext, t: Transcript): string {
  return ctx.artifacts.put(JSON.stringify(t)).hash;
}

function loadTranscript(ctx: AppContext, hash: string): Transcript {
  const b = ctx.artifacts.get(hash);
  if (!b) throw new AzhiError(ErrorClass.internal, `agent transcript ${hash} is missing from the artifact store`);
  return JSON.parse(b.toString('utf8'));
}

/** Assembles the context (stable parts first, for prefix caching) and the first manifest items. */
export async function agentBegin(ctx: AppContext, i: AgentBeginInput): Promise<AgentState> {
  const store = ctx.settings.storeContextContent;
  const { path, profile } = await loadProfile(ctx, i.workspaceId, i.packageHash, i.profile);
  const model = resolveModelName(ctx, profile);
  const items: ManifestItem[] = [item('instructions', 'platform', 'always included', PLATFORM_RULES, store), item('profile', path, `agent profile ${i.profile}`, profile.instructions, store)];

  const wrapped = i.outputSchema.type !== 'object';
  const submitSchema = wrapped ? { type: 'object', properties: { value: i.outputSchema }, required: ['value'] } : i.outputSchema;
  const tools: ModelTool[] = [];
  const toolRefs: Record<string, string> = {};
  for (const t of i.tools) {
    const spec = await loadToolRevision(ctx, i.workspaceId, t.ref, t.revision);
    if (!spec) throw new AzhiError(ErrorClass.unsupportedCapability, `agent tool ${t.ref} is not registered`);
    const mt: ModelTool = { name: toolName(t.ref), description: `${spec.description} (effect: ${spec.effect})`, input_schema: spec.input_schema as Record<string, unknown> };
    tools.push(mt);
    toolRefs[mt.name] = t.ref;
    items.push(item('tool_schema', `${t.ref}${t.revision ? ` revision ${t.revision}` : ''}`, 'allowlisted for this node', JSON.stringify(mt), store));
  }
  const submit: ModelTool = { name: SUBMIT_TOOL, description: 'Return the final result of this node. Call exactly once.', input_schema: submitSchema };
  tools.push(submit);
  items.push(item('output_schema', `node ${i.nodeId}`, 'output contract, validated by the platform', JSON.stringify(submitSchema), store));

  const input = materialise(ctx, i.input);
  const inputText = `Input:\n\`\`\`json\n${JSON.stringify(input ?? null, null, 2)}\n\`\`\``;
  items.push(item('input', i.inputSources.length ? i.inputSources.map((s) => `nodes.${s}`).join(', ') : 'inputs', 'node input', inputText, store));
  let user = inputText;
  if (i.chunks?.length) {
    const excerpts = i.chunks.map((c) => `[${c.id}] ${c.heading ? `${c.heading}: ` : ''}${c.text}`);
    for (const [n, c] of i.chunks.entries()) items.push(item('chunk', `${c.dataset}@${c.revision} ${c.id}`, `retrieved for the node input (rank ${n + 1})`, excerpts[n]!, store));
    user += `\n\nRetrieved excerpts (cite by id):\n${excerpts.join('\n\n')}`;
  }

  const t: Transcript = {
    profile: i.profile,
    profilePath: path,
    provider: profile.model.provider,
    model,
    system: `${PLATFORM_RULES}\n\n${profile.instructions}`,
    tools,
    toolRefs,
    outputSchema: i.outputSchema,
    wrapped,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    items,
    chunkIds: (i.chunks ?? []).map((c) => c.id),
  };
  return { transcript: saveTranscript(ctx, t), turn: 0, toolCalls: 0, outputTokens: 0, cost: 0, repairs: 0, failures: {} };
}

/** One model turn: call the model, run its tool calls through the gateway, validate output. */
export async function agentTurn(ctx: AppContext, i: AgentTurnInput, opts: { fence: number; signal?: AbortSignal }): Promise<AgentTurnResult> {
  const store = ctx.settings.storeContextContent;
  const t = loadTranscript(ctx, i.state.transcript);
  const { profile } = await loadProfile(ctx, i.workspaceId, i.packageHash, t.profile);
  const turn = i.state.turn + 1;
  const maxTurns = profile.max_turns ?? DEFAULT_MAX_TURNS;
  if (turn > maxTurns) throw new AzhiError(ErrorClass.contractViolation, `the agent produced no valid output within ${maxTurns} turns`);

  const remaining = i.budget?.max_output_tokens !== undefined && i.state.outputTokens !== null ? i.budget.max_output_tokens - i.state.outputTokens : undefined;
  const maxTokens = Math.max(1, Math.min(profile.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, remaining ?? Infinity));
  const provider = await providerFor(ctx, i.workspaceId, profile);
  const res = await provider.complete({ model: t.model, system: t.system, messages: t.messages, tools: t.tools, maxTokens, temperature: profile.temperature, signal: opts.signal });

  // Usage and cost: unknown stays null, cost is estimated only from declared pricing.
  const usageKnown = res.usage.input_tokens !== null && res.usage.output_tokens !== null;
  const cost = estimateCost(res.usage, profile.pricing);
  await ctx.pool.query(
    `INSERT INTO usage_records(workspace_id, run_id, node_id, attempt, turn, executor, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_label, pricing_revision)
     VALUES ($1,$2,$3,1,$4,'model-agent',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (run_id, node_id, attempt, turn) DO UPDATE SET input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens,
       cache_read_tokens=EXCLUDED.cache_read_tokens, cache_write_tokens=EXCLUDED.cache_write_tokens, cost=EXCLUDED.cost, cost_label=EXCLUDED.cost_label, at=now()`,
    [
      i.workspaceId,
      i.runId,
      i.nodeId,
      turn,
      provider.id,
      res.model,
      res.usage.input_tokens,
      res.usage.output_tokens,
      res.usage.cache_read_tokens,
      res.usage.cache_write_tokens,
      res.usage.reasoning_tokens,
      cost,
      cost === null ? null : profile.pricing!.currency,
      cost === null ? 'unavailable' : 'estimated',
      cost === null ? null : profile.pricing!.revision,
    ],
  );
  const estimated = t.items.reduce((n, x) => n + x.tokens, 0);
  await ctx.pool.query(
    `INSERT INTO context_manifests(workspace_id, run_id, node_id, attempt, turn, tainted, items, total_tokens, token_source) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)
     ON CONFLICT (run_id, node_id, attempt, turn) DO UPDATE SET items=EXCLUDED.items, total_tokens=EXCLUDED.total_tokens, token_source=EXCLUDED.token_source`,
    [i.workspaceId, i.runId, i.nodeId, turn, Boolean(i.tainted), JSON.stringify(t.items), res.usage.input_tokens ?? estimated, res.usage.input_tokens === null ? 'estimated' : 'reported'],
  );

  const state: AgentState = {
    ...i.state,
    turn,
    outputTokens: i.state.outputTokens === null || res.usage.output_tokens === null ? null : i.state.outputTokens + res.usage.output_tokens,
    cost: i.state.cost === null || cost === null ? null : i.state.cost + cost,
    failures: { ...i.state.failures },
  };
  if (i.budget?.max_output_tokens !== undefined && state.outputTokens !== null && state.outputTokens > i.budget.max_output_tokens) {
    throw new AzhiError(ErrorClass.budgetExceeded, `output tokens ${state.outputTokens} exceed the budget of ${i.budget.max_output_tokens}`);
  }
  if (i.budget?.max_cost_usd !== undefined && state.cost !== null && state.cost > i.budget.max_cost_usd) {
    throw new AzhiError(ErrorClass.budgetExceeded, `estimated cost ${state.cost.toFixed(4)} exceeds the budget of ${i.budget.max_cost_usd}`);
  }

  t.messages.push({ role: 'assistant', content: res.content });
  const results: Block[] = [];
  let output: unknown;
  let done = false;
  const toolUses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
  for (const [n, call] of toolUses.entries()) {
    if (call.name === SUBMIT_TOOL) {
      const value = t.wrapped ? (call.input as { value?: unknown }).value : call.input;
      const validate = ajv.compile(t.outputSchema);
      const unknownCitations = citationIds(value).filter((id) => !(t.chunkIds ?? []).includes(id));
      if (validate(value) && unknownCitations.length) {
        state.repairs++;
        if (state.repairs > MAX_REPAIRS) throw new AzhiError(ErrorClass.contractViolation, `output cites excerpts it was not given: ${unknownCitations.join(', ')}`);
        const feedback = JSON.stringify({ error: 'contract_violation', message: `cite only the excerpt ids you were given; unknown: ${unknownCitations.join(', ')}` });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: feedback, is_error: true });
        t.items.push(item('repair', 'platform', `output cited unknown excerpts (repair ${state.repairs} of ${MAX_REPAIRS})`, feedback, store));
        continue;
      }
      if (validate(value)) {
        output = value;
        done = true;
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'accepted' });
        continue;
      }
      state.repairs++;
      if (state.repairs > MAX_REPAIRS) throw new AzhiError(ErrorClass.contractViolation, `output still invalid after ${MAX_REPAIRS} repair attempts: ${ajv.errorsText(validate.errors)}`);
      const feedback = JSON.stringify({ error: 'contract_violation', failed_fields: (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message })) });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: feedback, is_error: true });
      t.items.push(item('repair', 'platform', `output failed validation (repair ${state.repairs} of ${MAX_REPAIRS})`, feedback, store));
      continue;
    }

    const ref = t.toolRefs[call.name];
    const tool = i.tools.find((x) => x.ref === ref);
    let content: string;
    let isError = false;
    state.toolCalls++;
    if (i.budget?.max_tool_calls !== undefined && state.toolCalls > i.budget.max_tool_calls) {
      throw new AzhiError(ErrorClass.budgetExceeded, `tool calls exceed the budget of ${i.budget.max_tool_calls}`);
    }
    if (!ref || !tool) {
      content = JSON.stringify({ error: 'authorization', message: `tool ${call.name} is not allowed for this node` });
      isError = true;
    } else if (i.tainted && tool.effect !== 'read' && !tool.safeForTainted) {
      // ADR-10: the gateway refuses writes from a tainted agent unless the tool is marked safe.
      content = JSON.stringify({ error: 'authorization', message: `refused: this agent's context is tainted (${i.tainted}) and ${ref} is a ${tool.effect} tool not marked safe_for_tainted` });
      isError = true;
      await ctx.pool.query(`INSERT INTO run_events(workspace_id, run_id, kind, node_id, data) VALUES ($1,$2,'gateway.refused',$3,$4)`, [
        i.workspaceId,
        i.runId,
        i.nodeId,
        JSON.stringify({ tool: ref, reason: 'tainted_write' }),
      ]);
    } else if (i.mockWrites && tool.effect !== 'read') {
      content = JSON.stringify({ mocked: true, tool: ref, args: call.input });
    } else {
      try {
        const r = await callTool(ctx, {
          workspaceId: i.workspaceId,
          runId: i.runId,
          nodeId: i.nodeId,
          attempt: opts.fence,
          tool: ref,
          revision: tool.revision,
          args: call.input,
          allowed: i.tools.map((x) => x.ref),
          ordinal: turn * 100 + n,
        });
        content = contextSafe(r.output, r.observation.artifact);
      } catch (err) {
        if (!(err instanceof AzhiError)) throw err;
        if (err.errorClass === ErrorClass.transient) throw err;
        content = JSON.stringify({ error: err.errorClass, message: err.message, ...(err.details?.failed_fields ? { failed_fields: err.details.failed_fields } : {}) });
        isError = true;
      }
    }
    if (isError) {
      const signature = sha256(canonicalJson({ tool: call.name, args: call.input, error: JSON.parse(content).error }));
      state.failures[signature] = (state.failures[signature] ?? 0) + 1;
      if (state.failures[signature]! > MAX_REPEATED_FAILURES) {
        throw new AzhiError(ErrorClass.contractViolation, `the agent repeated a failing call to ${ref ?? call.name} after ${MAX_REPEATED_FAILURES} correction attempts: ${content}`);
      }
    }
    results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    t.items.push(item('tool_result', ref ?? call.name, isError ? 'tool call failed' : 'tool call result', content, store));
  }

  if (!done && toolUses.length === 0) {
    state.repairs++;
    if (state.repairs > MAX_REPAIRS) throw new AzhiError(ErrorClass.contractViolation, `the agent did not call ${SUBMIT_TOOL} after ${MAX_REPAIRS} reminders`);
    const reminder = `Return your result by calling ${SUBMIT_TOOL}.`;
    results.push({ type: 'text', text: reminder });
    t.items.push(item('repair', 'platform', 'no output submitted', reminder, store));
  }
  if (!done) t.messages.push({ role: 'user', content: results });
  state.transcript = saveTranscript(ctx, t);
  return { state, done, ...(done ? { output } : {}), usageKnown };
}

/** Tool output for agent context: within the 8 KiB ceiling, or a summary plus the artifact handle. */
function contextSafe(output: unknown, artifact: string): string {
  const text = JSON.stringify(output);
  if (byteSize(output) <= CONTEXT_CEILING_BYTES) return text;
  const shape = Array.isArray(output) ? { items: output.length } : output && typeof output === 'object' ? { fields: Object.keys(output as object) } : {};
  return JSON.stringify({ note: `output is ${byteSize(output)} bytes, above the ${CONTEXT_CEILING_BYTES}-byte context ceiling; not included`, artifact, ...shape });
}

export function estimateCost(u: Usage, pricing: AgentProfile['pricing']): number | null {
  if (!pricing || u.input_tokens === null || u.output_tokens === null) return null;
  const per = (n: number | null, price: number | undefined) => ((n ?? 0) * (price ?? 0)) / 1_000_000;
  return per(u.input_tokens, pricing.input_per_mtok) + per(u.output_tokens, pricing.output_per_mtok) + per(u.cache_read_tokens, pricing.cache_read_per_mtok) + per(u.cache_write_tokens, pricing.cache_write_per_mtok);
}

/**
 * Harness executors get the same context the model agent would: platform rules and profile as
 * the system prompt, the input and retrieved excerpts as the prompt, the node's gateway tools.
 * The manifest adds one item for what the harness owns and Azhi cannot see.
 */
export async function harnessPrepare(ctx: AppContext, i: AgentBeginInput, executor: string) {
  const state = await agentBegin(ctx, i);
  const t = loadTranscript(ctx, state.transcript);
  const { profile } = await loadProfile(ctx, i.workspaceId, i.packageHash, i.profile);
  // The run plan marks providers an adapter cannot drive as unsupported; this is the same check at run time.
  const provider = profile.model.provider;
  if (provider === 'scripted' || !EXECUTORS[executor]?.providers.includes(provider)) {
    throw new AzhiError(ErrorClass.unsupportedCapability, `the ${executor} executor needs a ${EXECUTORS[executor]?.providers.join(' or ') ?? 'supported'} profile, not ${provider}`);
  }
  const items = [
    ...t.items,
    { kind: 'instructions' as const, source: executor, reason: 'harness-owned system prompt, built-in tool schemas and compaction; not observable', tokens: 0, content_hash: 'unobservable' },
  ];
  await ctx.pool.query(
    `INSERT INTO context_manifests(workspace_id, run_id, node_id, attempt, turn, tainted, items, total_tokens, token_source) VALUES ($1,$2,$3,1,1,$4,$5,NULL,'estimated')
     ON CONFLICT (run_id, node_id, attempt, turn) DO UPDATE SET items=EXCLUDED.items`,
    [i.workspaceId, i.runId, i.nodeId, false, JSON.stringify(items)],
  );
  const first = t.messages[0]!.content[0];
  return {
    system: t.system,
    prompt: first && first.type === 'text' ? first.text : '',
    tools: t.tools.filter((x) => x.name !== SUBMIT_TOOL).map((x) => ({ name: x.name, ref: t.toolRefs[x.name]!, description: x.description, input_schema: x.input_schema })),
    outputSchema: t.outputSchema,
    model: t.model,
    credential: profile.model.credential ?? PROVIDER_DEFAULTS[provider].credential,
    providerUrl: PROVIDER_DEFAULTS[provider].apiUrl(ctx.settings),
    provider,
  };
}

export { loadProfile };
