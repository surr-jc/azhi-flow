import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { anthropicProvider, openaiProvider, PROVIDER_DEFAULTS, type Block, type Message, type ModelProvider, type ModelTool, type Usage } from '../agents/providers.js';
import { examplesDir } from '../api/examples.js';
import type { Diagnostic } from '../definition/load.js';
import { EXECUTORS } from '../executors/capabilities.js';
import { toolRef, type ToolSpec } from '../gateway/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { loadCatalog } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { packageFile, stagePackage } from '../server/packages.js';
import { resolveSecret } from '../server/secrets.js';
import { checkPackage, getVersion, type VersionRow } from '../server/workflows.js';

/**
 * The workflow builder chat: a model, given the workflow-builder skill (skill.md), interviews a
 * person about a requirement, looks up what the workspace has (tools, datasets, secrets,
 * workflows, examples, executors), and proposes a whole package. Each proposal is compiled and
 * run-planned against the workspace exactly as an upload would be; compiler errors go back to the
 * model to repair. Nothing is stored here: saving goes through the normal package upload as an
 * unsigned draft, so publishing still needs a person's signature.
 *
 * The browser keeps the transcript (provider-neutral blocks) and sends it with each message.
 */
export type BuilderProviderId = 'anthropic' | 'openai';

export interface BuilderProviderInfo {
  id: BuilderProviderId;
  ready: boolean;
  model?: string;
  reason?: string;
}

/** A question the builder asks; the browser shows options as choices and always allows a free answer. */
export interface BuilderQuestion {
  id: string;
  question: string;
  why?: string;
  options?: string[];
  multiple?: boolean;
}

export interface BuilderProposal {
  tool_use_id: string;
  id: string;
  name?: string;
  summary: string;
  files: Record<string, string>;
  /** Plan nodes, for the canvas preview. */
  nodes: unknown[];
  warnings: Diagnostic[];
  missing: Array<{ kind: string; name: string; node: string }>;
  blockers: Array<{ code: string; message: string; node?: string }>;
  /** The workflow id already exists: saving adds a new draft version of it. */
  new_version_of?: string;
}

export type BuilderEvent =
  | { kind: 'text' }
  | { kind: 'questions'; tool_use_id: string; intro?: string; questions: BuilderQuestion[] }
  | { kind: 'proposal'; proposal: BuilderProposal };

const SKILL = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
/** Model calls per person message: lookups plus a few compile-and-repair rounds. */
const MAX_CALLS = 16;
const MAX_OUTPUT_TOKENS = 16_000;
const RESULT_CHARS = 24_000;
/** Paths a proposed package may hold. */
const PACKAGE_PATH = /^(?:workflow\.yaml|(?:profiles|schemas|templates|scripts|harness)\/(?:[A-Za-z0-9_-][A-Za-z0-9._@-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._@-]*\.(?:ya?ml|json|md|txt|py|ts|js|mjs|toml|lock|csv|html))$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** Anthropic's current mid-size model, when neither AZHI_BUILDER_MODEL nor AZHI_ANTHROPIC_MODEL is set. */
const ANTHROPIC_FALLBACK_MODEL = 'claude-sonnet-5-5';

async function hasSecret(ctx: AppContext, workspaceId: string, name: string): Promise<boolean> {
  return (await ctx.pool.query(`SELECT 1 FROM secrets WHERE workspace_id=$1 AND name=$2 LIMIT 1`, [workspaceId, name])).rows.length > 0;
}

/** Which providers the builder can use here, and with which model. */
export async function builderProviders(ctx: AppContext, workspaceId: string): Promise<{ providers: BuilderProviderInfo[]; default?: BuilderProviderId }> {
  const s = ctx.settings;
  const out: BuilderProviderInfo[] = [];
  for (const id of ['anthropic', 'openai'] as const) {
    const d = PROVIDER_DEFAULTS[id];
    const model = s.builderModel && (!s.builderProvider || s.builderProvider === id) ? s.builderModel : (d.model(s) ?? (id === 'anthropic' ? ANTHROPIC_FALLBACK_MODEL : undefined));
    if (!(await hasSecret(ctx, workspaceId, d.credential))) out.push({ id, ready: false, model, reason: `the workspace secret ${d.credential} is not set` });
    else if (!model) out.push({ id, ready: false, reason: `set ${d.modelEnv} (or AZHI_BUILDER_MODEL) on the server` });
    else out.push({ id, ready: true, model });
  }
  const ready = out.filter((p) => p.ready);
  const preferred = ready.find((p) => p.id === s.builderProvider) ?? ready[0];
  return { providers: out, default: preferred?.id };
}

async function providerFor(ctx: AppContext, workspaceId: string, wanted?: BuilderProviderId): Promise<{ provider: ModelProvider; info: BuilderProviderInfo }> {
  const { providers, default: def } = await builderProviders(ctx, workspaceId);
  const id = wanted ?? def;
  const info = providers.find((p) => p.id === id);
  if (!info || !info.ready) {
    const why = info?.reason ?? 'no model provider is set up';
    throw new AzhiError(ErrorClass.unsupportedCapability, `the workflow builder needs an Anthropic or OpenAI key: ${why}. Add one under Governance › Secrets.`);
  }
  const d = PROVIDER_DEFAULTS[info.id];
  const secret = await resolveSecret(ctx, workspaceId, d.credential);
  if (!secret) throw new AzhiError(ErrorClass.authorization, `credential '${d.credential}' is not set`);
  const make = info.id === 'openai' ? openaiProvider : anthropicProvider;
  return { provider: make({ apiUrl: d.apiUrl(ctx.settings), apiKey: secret.value }), info };
}

const TOOLS: ModelTool[] = [
  {
    name: 'workspace_overview',
    description: 'What this workspace has: registered tools, datasets, workflows, examples, executors, model providers and which well-known secrets are set. Call once at the start.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_tool',
    description: 'A registered tool by ref (id@version): description, input and output JSON Schemas, effect, credential, trust marks.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
  },
  {
    name: 'read_example',
    description: 'The files of a shipped example workflow (workflow.yaml, profiles, schemas, templates, and its azhi.config.yaml with tool registrations). Use to copy proven patterns.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'read_workflow',
    description: "An existing workflow's latest version, as package files. Use when the person wants to change or extend one, or to call it as a subworkflow.",
    input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'ask_user',
    description: 'Ask the person 1 to 5 questions at once and wait for the answers. Give short options when there are natural choices; mark one "(recommended)". The person can always answer freely.',
    input_schema: {
      type: 'object',
      properties: {
        intro: { type: 'string', description: 'One or two sentences before the questions.' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              why: { type: 'string', description: 'Why it matters, one short line.' },
              options: { type: 'array', items: { type: 'string' }, maxItems: 6 },
              multiple: { type: 'boolean', description: 'More than one option may be picked.' },
            },
            required: ['id', 'question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'propose_workflow',
    description:
      'Propose the whole workflow package. The server compiles it against this workspace; errors come back for you to fix. When it compiles, the person sees the draft with a button to save it as an unsigned draft and open the editor.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Plain-language summary: what it does, assumptions, what the person must set up.' },
        files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Package path to file text. Must include workflow.yaml.' },
        new_version_of: { type: 'string', description: 'Set to the workflow id only when the person asked to change that existing workflow.' },
      },
      required: ['summary', 'files'],
    },
  },
];

const clip = (s: string) => (s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n…(cut at ${RESULT_CHARS} characters)` : s);

/** Secret names worth reporting: model keys, Slack, and every tool credential. Only whether each is set. */
async function secretStatus(ctx: AppContext, workspaceId: string, tools: ToolSpec[]): Promise<Record<string, boolean>> {
  const names = new Set<string>(['anthropic-api-key', 'openai-api-key', 'slack-bot-token']);
  for (const t of tools) if (t.credential) names.add(t.credential);
  const set = new Set((await ctx.pool.query(`SELECT DISTINCT name FROM secrets WHERE workspace_id=$1`, [workspaceId])).rows.map((r) => r.name as string));
  return Object.fromEntries([...names].sort().map((n) => [n, set.has(n)]));
}

function examples(): Array<{ id: string; name: string; description: string }> {
  const dir = examplesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => SLUG.test(d) && existsSync(join(dir, d, 'workflow.yaml')))
    .sort()
    .map((id) => {
      const wf = parse(readFileSync(join(dir, id, 'workflow.yaml'), 'utf8')) ?? {};
      return { id, name: String(wf.name ?? id), description: String(wf.description ?? '') };
    });
}

function readExample(id: string): string {
  if (!SLUG.test(id)) throw new Error(`no example '${id}'`);
  const root = join(examplesDir(), id);
  if (!existsSync(join(root, 'workflow.yaml'))) throw new Error(`no example '${id}'; see workspace_overview for the list`);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || ['fixtures', 'knowledge', 'node_modules', '.venv'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ya?ml|json|md|py|ts|mjs|js)$/.test(name) && statSync(p).size <= 32 * 1024) out.push(`=== ${relative(root, p)} ===\n${readFileSync(p, 'utf8')}`);
    }
  };
  walk(root);
  return out.join('\n\n');
}

async function latestVersion(ctx: AppContext, workspaceId: string, slug: string): Promise<VersionRow | undefined> {
  const r = await ctx.pool.query(
    `SELECT v.id FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE v.workspace_id=$1 AND w.slug=$2 ORDER BY v.version DESC LIMIT 1`,
    [workspaceId, slug],
  );
  return r.rows[0] ? getVersion(ctx, workspaceId, r.rows[0].id) : undefined;
}

async function overview(ctx: AppContext, workspaceId: string, provider: BuilderProviderInfo) {
  const catalog = await loadCatalog(ctx, workspaceId);
  const tools = catalog.list();
  const datasets = (
    await ctx.pool.query(
      `SELECT d.name, d.trusted, (SELECT coalesce(jsonb_object_agg(tag, revision), '{}') FROM dataset_tags t WHERE t.dataset_id = d.id) AS tags,
         (SELECT count(*)::int FROM dataset_documents x WHERE x.dataset_id = d.id AND NOT x.revoked) AS documents
       FROM datasets d WHERE d.workspace_id=$1 ORDER BY d.name`,
      [workspaceId],
    )
  ).rows;
  const workflows = (
    await ctx.pool.query(
      `SELECT w.slug, (SELECT v.definition->>'name' FROM workflow_versions v WHERE v.workflow_id=w.id ORDER BY v.version DESC LIMIT 1) AS name,
         EXISTS (SELECT 1 FROM workflow_versions v WHERE v.workflow_id=w.id AND NOT v.draft) AS published
       FROM workflows w WHERE w.workspace_id=$1 ORDER BY w.slug`,
      [workspaceId],
    )
  ).rows;
  return {
    model_provider_for_profiles: { provider: provider.id, credential: PROVIDER_DEFAULTS[provider.id].credential },
    tools: tools.map((t) => ({ ref: toolRef(t), description: t.description, effect: t.effect, output_trusted: t.output_trusted === true, safe_for_tainted: t.safe_for_tainted === true, credential: t.credential })),
    datasets,
    workflows,
    examples: examples(),
    executors: Object.values(EXECUTORS).map((e) => ({ id: e.id, providers: e.providers, notes: e.notes })),
    secrets_set: await secretStatus(ctx, workspaceId, tools),
    note: 'Secret values are never shown. A missing secret is set by an admin under Governance › Secrets.',
  };
}

async function getTool(ctx: AppContext, workspaceId: string, ref: string) {
  const t = (await loadCatalog(ctx, workspaceId)).get(ref);
  if (!t) throw new Error(`tool '${ref}' is not registered; see workspace_overview for the list`);
  const { transport, ...rest } = t;
  return { ...rest, ref: toolRef(t), transport: transport.kind };
}

async function readWorkflow(ctx: AppContext, workspaceId: string, slug: string): Promise<string> {
  const v = await latestVersion(ctx, workspaceId, slug);
  if (!v) throw new Error(`no workflow '${slug}'`);
  const out: string[] = [`(version ${v.version}${v.draft ? ', draft' : ''})`];
  for (const f of v.manifest.files) {
    if (!PACKAGE_PATH.test(f.path) || f.size > 32 * 1024) continue;
    out.push(`=== ${f.path} ===\n${(await packageFile(ctx, workspaceId, v.package_hash, f.path)).toString('utf8')}`);
  }
  return out.join('\n\n');
}

const describe = (d: Diagnostic) => `${d.severity} ${d.code}${d.node ? ` [${d.node}]` : ''}${d.path ? ` at ${d.path}` : ''}: ${d.message}`;

/** Checks a proposed package's paths and id, compiles it, and builds its run plan. */
export async function checkProposal(
  ctx: AppContext,
  workspaceId: string,
  files: Record<string, unknown>,
  newVersionOf: string | undefined,
): Promise<{ ok: false; errors: string[] } | { ok: true; id: string; name?: string; files: Record<string, string>; nodes: unknown[]; warnings: Diagnostic[]; missing: BuilderProposal['missing']; blockers: BuilderProposal['blockers']; new_version_of?: string }> {
  const errors: string[] = [];
  const clean: Record<string, string> = {};
  const entries = Object.entries(files ?? {});
  if (entries.length > 60) errors.push('at most 60 files in a package proposal');
  for (const [path, text] of entries) {
    if (typeof text !== 'string') errors.push(`${path}: file contents must be text`);
    else if (!PACKAGE_PATH.test(path) || path.includes('..')) errors.push(`${path}: files are workflow.yaml or live under profiles/, schemas/, templates/, scripts/ or harness/`);
    else if (text.length > 64 * 1024) errors.push(`${path}: at most 64 KB per file`);
    else clean[path] = text;
  }
  if (!('workflow.yaml' in clean)) errors.push('the package needs workflow.yaml');
  if (errors.length) return { ok: false, errors };
  let id: string | undefined;
  try {
    id = (parse(clean['workflow.yaml']!) ?? {}).id;
  } catch {
    /* the compiler reports the YAML error below */
  }
  if (typeof id === 'string') {
    if (!SLUG.test(id)) return { ok: false, errors: [`workflow id '${id}' must be a lowercase slug (letters, digits, hyphens)`] };
    const exists = (await ctx.pool.query(`SELECT 1 FROM workflows WHERE workspace_id=$1 AND slug=$2`, [workspaceId, id])).rows.length > 0;
    if (exists && newVersionOf !== id) return { ok: false, errors: [`a workflow with id '${id}' already exists: pick a new id, or set new_version_of: '${id}' if the person asked to change that workflow`] };
    if (!exists && newVersionOf) return { ok: false, errors: [`there is no workflow '${newVersionOf}' to make a new version of; leave new_version_of out for a new workflow`] };
  }
  const buffers = new Map(Object.entries(clean).map(([p, t]) => [p, Buffer.from(t)]));
  const r = await checkPackage(ctx, workspaceId, 'workflow.yaml', buffers);
  if (!r.ok) return { ok: false, errors: r.diagnostics.map(describe) };
  const draft: VersionRow = {
    id: 'wfv_builder',
    workflow_id: '',
    slug: r.definition.id,
    version: 0,
    package_hash: r.pkg.hash,
    manifest: r.pkg.manifest,
    definition: r.definition,
    plan: r.compiled.plan,
    draft: true,
    signature: null,
  };
  stagePackage(ctx, workspaceId, r.pkg.hash, r.pkg.manifest, buffers);
  let missing: BuilderProposal['missing'] = [];
  let blockers: BuilderProposal['blockers'] = [];
  try {
    const plan = await buildRunPlan(ctx, workspaceId, draft);
    missing = plan.missing_grants;
    // Every draft is unsigned and may have no worker yet; those are not the builder's to fix.
    blockers = plan.blockers.filter((b) => !/sign|worker/i.test(`${b.code} ${b.message}`));
  } catch {
    /* the plan is a hint here; the editor shows the full one */
  }
  return {
    ok: true,
    id: r.definition.id,
    name: r.definition.name,
    files: clean,
    nodes: r.compiled.plan.nodes.map((n) => ({ id: n.id, type: n.type, deps: n.deps, ...(n.route ? { route: n.route } : {}), def: n.def })),
    warnings: r.compiled.diagnostics.filter((d) => d.severity !== 'error'),
    missing,
    blockers,
    new_version_of: newVersionOf,
  };
}

function system(info: BuilderProviderInfo): string {
  return `${SKILL}\n\n## This session\n\nToday is ${new Date().toISOString().slice(0, 10)}. You run on ${info.id} (${info.model}). Agent profiles you write should use provider ${info.id} with credential ${PROVIDER_DEFAULTS[info.id].credential} unless the person asks otherwise.`;
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
  output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
  cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0),
  cache_write_tokens: (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0),
  reasoning_tokens: null,
});

/**
 * One person message: appends it to the transcript and runs the model until it asks questions,
 * proposes a compiling draft, or answers in text.
 */
export async function builderTurn(
  ctx: AppContext,
  workspaceId: string,
  o: { messages: Message[]; text: string; provider?: BuilderProviderId; signal?: AbortSignal },
): Promise<{ messages: Message[]; event: BuilderEvent; provider: BuilderProviderId; model: string; usage: Usage }> {
  const { provider, info } = await providerFor(ctx, workspaceId, o.provider);
  const messages = structuredClone(o.messages);
  // After tool results the transcript ends on a user message; the person's words join it.
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text: o.text });
  else messages.push({ role: 'user', content: [{ type: 'text', text: o.text }] });

  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: null };
  for (let call = 0; call < MAX_CALLS; call++) {
    const res = await provider.complete({ model: info.model!, system: system(info), messages, tools: TOOLS, maxTokens: MAX_OUTPUT_TOKENS, signal: o.signal });
    usage = addUsage(usage, res.usage);
    messages.push({ role: 'assistant', content: res.content.length ? res.content : [{ type: 'text', text: '(no reply)' }] });
    const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return { messages, event: { kind: 'text' }, provider: info.id, model: info.model!, usage };

    const results: Block[] = [];
    let event: BuilderEvent | undefined;
    const answer = (id: string, content: string, is_error = false) => results.push({ type: 'tool_result', tool_use_id: id, content: clip(content), ...(is_error ? { is_error } : {}) });
    for (const u of uses) {
      const input = u.input as Record<string, any>;
      try {
        if (res.stop === 'max_tokens') {
          answer(u.id, `Your reply was cut off at ${MAX_OUTPUT_TOKENS} output tokens, so this call is incomplete. Send a shorter version (fewer or shorter files; inline small schemas).`, true);
        } else if (u.name === 'workspace_overview') {
          answer(u.id, JSON.stringify(await overview(ctx, workspaceId, info), null, 1));
        } else if (u.name === 'get_tool') {
          answer(u.id, JSON.stringify(await getTool(ctx, workspaceId, String(input.ref)), null, 1));
        } else if (u.name === 'read_example') {
          answer(u.id, readExample(String(input.id)));
        } else if (u.name === 'read_workflow') {
          answer(u.id, await readWorkflow(ctx, workspaceId, String(input.slug)));
        } else if (u.name === 'ask_user') {
          const questions = (Array.isArray(input.questions) ? input.questions : []).slice(0, 5).map((q: any, i: number) => ({
            id: String(q?.id ?? `q${i + 1}`),
            question: String(q?.question ?? ''),
            ...(q?.why ? { why: String(q.why) } : {}),
            ...(Array.isArray(q?.options) && q.options.length ? { options: q.options.slice(0, 6).map(String) } : {}),
            ...(q?.multiple ? { multiple: true } : {}),
          }));
          answer(u.id, 'The questions are shown to the person. Their answers follow in the next message.');
          event = { kind: 'questions', tool_use_id: u.id, ...(input.intro ? { intro: String(input.intro) } : {}), questions };
        } else if (u.name === 'propose_workflow') {
          const r = await checkProposal(ctx, workspaceId, input.files, input.new_version_of ? String(input.new_version_of) : undefined);
          if (!r.ok) {
            answer(u.id, `The draft does not compile yet. Fix these and propose the whole package again:\n${r.errors.map((e) => `- ${e}`).join('\n')}`, true);
          } else {
            const notes = [
              ...r.warnings.map(describe),
              ...r.missing.map((m) => `missing ${m.kind} '${m.name}' (step ${m.node})`),
              ...r.blockers.map((b) => `run plan blocker ${b.code}: ${b.message}`),
            ];
            answer(u.id, `Compiled. The person now sees draft '${r.id}' with a button to save it as an unsigned draft.${notes.length ? `\nTell them about:\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}\nNow summarise it for them in a few plain sentences.`);
            const { ok: _ok, ...p } = r;
            event = { kind: 'proposal', proposal: { tool_use_id: u.id, summary: String(input.summary ?? ''), ...p } };
          }
        } else {
          answer(u.id, `unknown tool ${u.name}`, true);
        }
      } catch (e) {
        answer(u.id, (e as Error).message, true);
      }
    }
    messages.push({ role: 'user', content: results });
    // Questions end the turn at once; a compiled proposal gets one more call for the summary.
    if (event?.kind === 'questions') return { messages, event, provider: info.id, model: info.model!, usage };
    if (event?.kind === 'proposal') {
      const res2 = await provider.complete({ model: info.model!, system: system(info), messages, tools: TOOLS, maxTokens: 2000, signal: o.signal });
      usage = addUsage(usage, res2.usage);
      const text = res2.content.filter((b) => b.type === 'text');
      if (text.length) messages.push({ role: 'assistant', content: text });
      return { messages, event, provider: info.id, model: info.model!, usage };
    }
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I stopped after many steps without a draft. Tell me what to focus on, or say "draft it" and I will propose one with my assumptions.' }] });
  return { messages, event: { kind: 'text' }, provider: info.id, model: info.model!, usage };
}
