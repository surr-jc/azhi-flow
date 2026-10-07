import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { anthropicProvider, openaiProvider, responsesProvider, PROVIDER_DEFAULTS, type Block, type Message, type ModelProvider, type ModelTool, type Usage } from '../agents/providers.js';
import { chatgptAuth } from '../agents/chatgpt-auth.js';
import { freshChatgptAuth } from '../api/chatgpt.js';
import { copilotApi, copilotSignIn, OPENCODE_USER_AGENT } from '../api/copilot.js';
import { examplesDir } from '../api/examples.js';
import type { Diagnostic } from '../definition/load.js';
import { EXECUTORS } from '../executors/capabilities.js';
import { toolRef, type ToolSpec } from '../gateway/types.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { buildRunPlan } from '../plan/run-plan.js';
import { loadCatalog, registerTool } from '../server/catalog.js';
import type { AppContext } from '../server/context.js';
import { packageFile, stagePackage } from '../server/packages.js';
import { resolveSecret } from '../server/secrets.js';
import { builderModels, copilotEndpoint, defaultBuilderModel } from './models.js';
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
export type BuilderProviderId = 'anthropic' | 'openai' | 'opencode' | 'chatgpt';

export interface BuilderProviderInfo {
  id: BuilderProviderId;
  label: string;
  ready: boolean;
  /** The model used when none is picked. */
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

/** A tool the builder proposes to register; nothing is stored until a person with the admin role confirms. */
export interface BuilderToolProposal {
  tool_use_id: string;
  ref: string;
  summary: string;
  spec: ToolSpec;
  /** The credential secret and whether it is already set; its value is never asked for in chat. */
  credential?: { name: string; set: boolean };
  /** A tool with this id@version is registered: confirming adds a new revision of it. */
  exists: boolean;
}

export type BuilderEvent =
  | { kind: 'text' }
  | { kind: 'tool_proposal'; proposal: BuilderToolProposal }
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
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,159}$/;
const LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', opencode: 'OpenCode (GitHub Copilot)', chatgpt: 'OpenCode (ChatGPT plan)' } as const;
/** The secret each builder provider needs; the OpenCode ones use the sign-ins OpenCode steps use (GitHub Copilot, ChatGPT plan). */
const CREDENTIAL = { anthropic: PROVIDER_DEFAULTS.anthropic.credential, openai: PROVIDER_DEFAULTS.openai.credential, opencode: PROVIDER_DEFAULTS['github-copilot'].credential, chatgpt: PROVIDER_DEFAULTS['openai-chatgpt'].credential } as const;
const MODEL_ENV = { anthropic: PROVIDER_DEFAULTS.anthropic.modelEnv, openai: PROVIDER_DEFAULTS.openai.modelEnv, opencode: PROVIDER_DEFAULTS['github-copilot'].modelEnv, chatgpt: PROVIDER_DEFAULTS['openai-chatgpt'].modelEnv } as const;

async function hasSecret(ctx: AppContext, workspaceId: string, name: string): Promise<boolean> {
  return (await ctx.pool.query(`SELECT 1 FROM secrets WHERE workspace_id=$1 AND name=$2 LIMIT 1`, [workspaceId, name])).rows.length > 0;
}

/**
 * Every model provider Azhi knows, whether the builder can use it here, and its default model.
 * OpenCode means GitHub Copilot's models with the Copilot sign-in OpenCode steps use, called the
 * way OpenCode calls them.
 */
export async function builderProviders(ctx: AppContext, workspaceId: string): Promise<{ providers: BuilderProviderInfo[]; default?: BuilderProviderId }> {
  const s = ctx.settings;
  const out: BuilderProviderInfo[] = [];
  for (const id of ['anthropic', 'openai', 'opencode', 'chatgpt'] as const) {
    const credential = CREDENTIAL[id];
    if (!(await hasSecret(ctx, workspaceId, credential))) {
      const reason =
        id === 'opencode'
          ? `sign in to GitHub Copilot first (Governance › Secrets › Sign in with GitHub Copilot); the workspace secret ${credential} is not set`
          : id === 'chatgpt'
            ? `sign in with your ChatGPT plan first (Governance › Secrets › Sign in with ChatGPT, or azhi chatgpt login); the workspace secret ${credential} is not set`
            : `the workspace secret ${credential} is not set`;
      out.push({ id, label: LABELS[id], ready: false, reason });
    } else out.push({ id, label: LABELS[id], ready: true, model: await defaultBuilderModel(ctx, workspaceId, id) });
  }
  const ready = out.filter((p) => p.ready);
  const preferred = ready.find((p) => p.id === s.builderProvider) ?? ready[0];
  return { providers: out, default: preferred?.id as BuilderProviderId | undefined };
}

async function providerFor(ctx: AppContext, workspaceId: string, wanted?: BuilderProviderId, model?: string): Promise<{ provider: ModelProvider; info: BuilderProviderInfo & { id: BuilderProviderId; model: string } }> {
  const { providers, default: def } = await builderProviders(ctx, workspaceId);
  const id = wanted ?? def;
  const info = providers.find((p) => p.id === id);
  if (!info || !info.ready) {
    const why = info?.reason ?? 'no model provider is set up';
    throw new AzhiError(ErrorClass.unsupportedCapability, `the workflow builder needs an Anthropic or OpenAI key, or a GitHub Copilot or ChatGPT sign-in for OpenCode: ${why}. Add one under Governance › Secrets.`);
  }
  if (model !== undefined && !MODEL_ID.test(model)) throw new AzhiError(ErrorClass.invalidInput, `'${model}' is not a model id`);
  const chosen = model ?? info.model;
  if (!chosen) throw new AzhiError(ErrorClass.invalidInput, `pick a ${info.label} model, or set ${MODEL_ENV[info.id]} on the server`);
  const credential = CREDENTIAL[info.id];
  const secret = await resolveSecret(ctx, workspaceId, credential);
  if (!secret) throw new AzhiError(ErrorClass.authorization, `credential '${credential}' is not set`);
  const done = { ...info, model: chosen };
  if (info.id === 'opencode') return { provider: copilotProvider(ctx, secret.value, await copilotEndpoint(ctx, workspaceId, chosen)), info: done };
  if (info.id === 'chatgpt') return { provider: chatgptProvider(ctx, await freshChatgptAuth(ctx, workspaceId, credential, secret.value), credential), info: done };
  const d = PROVIDER_DEFAULTS[info.id];
  const make = info.id === 'openai' ? openaiProvider : anthropicProvider;
  return { provider: make({ apiUrl: d.apiUrl(ctx.settings), apiKey: secret.value }), info: done };
}

/**
 * GitHub Copilot with the sign-in OpenCode uses, called as OpenCode calls it: the sign-in's token as
 * the bearer, OpenCode's user agent, and x-initiator `user` only for a person's own message
 * (OpenCode marks tool rounds `agent`, which Copilot does not count as a new request). Models
 * Copilot serves only on the Responses API (its GPT-5 and Codex models) are called there.
 */
function copilotProvider(ctx: AppContext, signIn: string, endpoint: 'chat' | 'responses'): ModelProvider {
  const si = copilotSignIn(signIn);
  const common = {
    id: 'copilot',
    apiUrl: copilotApi(ctx, si.enterprise),
    apiKey: si.token,
    headers: (req: { messages: Message[] }) => {
      const last = req.messages.at(-1);
      const fromPerson = last?.role === 'user' && last.content.some((b) => b.type === 'text');
      return { 'user-agent': OPENCODE_USER_AGENT, 'openai-intent': 'conversation-edits', 'x-initiator': fromPerson ? 'user' : 'agent' };
    },
  };
  return endpoint === 'responses' ? responsesProvider({ ...common, path: '/responses' }) : openaiProvider({ ...common, path: '/chat/completions', maxTokensParam: 'max_tokens' });
}

/**
 * A ChatGPT plan through OpenAI's Codex endpoint, called as OpenCode's ChatGPT login calls it: the
 * sign-in's access token, the ChatGPT account id, OpenCode as originator, the Responses API as a stream.
 * The sign-in was renewed just before if it was about to expire (freshChatgptAuth).
 */
function chatgptProvider(ctx: AppContext, value: string, credential: string): ModelProvider {
  const a = chatgptAuth(value);
  if (!a) throw new AzhiError(ErrorClass.authorization, `secret ${credential} is not a ChatGPT sign-in; sign in with azhi chatgpt login`);
  return responsesProvider({
    id: 'chatgpt',
    apiUrl: ctx.settings.chatgptApiUrl,
    path: '/responses',
    apiKey: a.access,
    codex: true,
    headers: () => ({ originator: 'opencode', 'user-agent': OPENCODE_USER_AGENT, ...(a.accountId ? { 'ChatGPT-Account-Id': a.accountId } : {}) }),
  });
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
    name: 'propose_tool',
    description:
      'Propose registering one tool (an MCP tool on a stdio server, a registered remote Streamable HTTP MCP connection, or an HTTP call) that workflows can then call through the gateway. The server checks it; errors come back for you to fix. Nothing is registered until the person confirms with the admin role. Never put a secret value in the spec: name the credential and tell the person to set it on the Secrets page.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What the tool does, what the person must set up (secret, command installed on the worker), and how a workflow uses it.' },
        tool: {
          type: 'object',
          description: 'The tool spec: id, version, description, effect (read|write-idempotent|write-dedupable|write-unsafe), source, credential (secret name), transport ({kind:mcp-stdio, command:[...], tool, env?, credential_env?}, {kind:mcp-streamable-http, connection, tool}, or {kind:http, method, url, headers?}), timeout, input_schema, output_schema.',
        },
      },
      required: ['summary', 'tool'],
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

const EFFECTS = ['read', 'write-idempotent', 'write-dedupable', 'write-unsafe'];

/** Checks a proposed tool spec the way registration will, and reports what the person must set up. Throws a repairable message. */
export async function checkToolProposal(ctx: AppContext, workspaceId: string, raw: unknown): Promise<{ spec: ToolSpec; ref: string; exists: boolean; credential?: { name: string; set: boolean } }> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const errors: string[] = [];
  if (typeof o.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(o.id)) errors.push('id must be lower-case letters, digits, dots, dashes, e.g. acme.lookup-customer');
  if (!Number.isInteger(o.version) || o.version < 1) errors.push('version must be an integer from 1');
  if (typeof o.description !== 'string' || !o.description.trim()) errors.push('description is required');
  if (!EFFECTS.includes(o.effect)) errors.push(`effect must be one of ${EFFECTS.join(', ')}`);
  for (const k of ['input_schema', 'output_schema']) if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) errors.push(`${k} must be a JSON Schema object`);
  if (o.input_schema?.type !== 'object') errors.push("input_schema must have type 'object'");
  const t = o.transport;
  if (t?.kind === 'mcp-stdio') {
    if (!Array.isArray(t.command) || !t.command.length || t.command.some((c: unknown) => typeof c !== 'string')) errors.push('transport.command must be a list of strings');
    if (typeof t.tool !== 'string' || !t.tool) errors.push('transport.tool (the MCP tool name) is required');
  } else if (t?.kind === 'mcp-streamable-http') {
    if (typeof t.connection !== 'string' || !t.connection) errors.push('transport.connection (the registered MCP connection id) is required');
    if (typeof t.tool !== 'string' || !t.tool) errors.push('transport.tool (the remote MCP tool name) is required');
  } else if (t?.kind === 'http') {
    if (typeof t.url !== 'string' || !/^https?:\/\//.test(t.url)) errors.push('transport.url must be an http(s) address');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(t.method)) errors.push('transport.method must be GET, POST, PUT, PATCH or DELETE');
  } else errors.push("transport.kind must be 'mcp-stdio', 'mcp-streamable-http' or 'http' (built-in transports ship with Azhi)");
  if (o.credential !== undefined && (typeof o.credential !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(o.credential))) errors.push('credential must be a secret name such as acme-api-token');
  if (JSON.stringify(o).match(/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|xox[bp]-[A-Za-z0-9-]{10,})/)) errors.push('the spec contains something that looks like a secret; use a credential name and let the person set its value on the Secrets page');
  if (errors.length) throw new Error(`The tool spec is not valid yet. Fix these and propose it again:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const spec = o as unknown as ToolSpec;
  const ref = toolRef(spec);
  const exists = (await loadCatalog(ctx, workspaceId)).get(ref) !== undefined;
  let credential: { name: string; set: boolean } | undefined;
  if (spec.credential) credential = { name: spec.credential, set: (await ctx.pool.query(`SELECT 1 FROM secrets WHERE workspace_id=$1 AND name=$2 LIMIT 1`, [workspaceId, spec.credential])).rows.length > 0 };
  return { spec, ref, exists, ...(credential ? { credential } : {}) };
}

/** Registers a confirmed tool proposal (a new revision when its spec changed). */
export async function registerProposedTool(ctx: AppContext, workspaceId: string, raw: unknown, actor: string) {
  let c;
  try {
    c = await checkToolProposal(ctx, workspaceId, raw);
  } catch (e) {
    throw new AzhiError(ErrorClass.invalidInput, (e as Error).message);
  }
  return { ref: c.ref, ...(await registerTool(ctx, workspaceId, c.spec, actor)) };
}

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
  // The models a profile may name (model.name) for the token-usage strategy; `default` is the server's choice.
  const listed = await builderModels(ctx, workspaceId, provider.id).catch(() => undefined);
  const models = {
    default_model: PROVIDER_DEFAULTS[profileProvider(provider.id).provider as keyof typeof PROVIDER_DEFAULTS].model(ctx.settings) ?? null,
    available: (listed?.models ?? []).slice(0, 40).map((m) => (m.label !== m.id ? `${m.id} (${m.label})` : m.id)),
    note: 'Pin model.name to one of these only when the token-usage strategy calls for a different tier than the default; otherwise keep name: default.',
  };
  return {
    model_provider_for_profiles: profileProvider(provider.id),
    models_for_profiles: models,
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

/** What profiles drafted in this session use: the builder's own provider (OpenCode's is github-copilot, on executor opencode). */
function profileProvider(id: BuilderProviderId) {
  if (id === 'opencode') return { provider: 'github-copilot', credential: CREDENTIAL.opencode, executor: 'opencode' };
  if (id === 'chatgpt') return { provider: 'openai-chatgpt', credential: CREDENTIAL.chatgpt, executor: 'opencode' };
  return { provider: id, credential: CREDENTIAL[id] };
}

function system(info: BuilderProviderInfo): string {
  const p = profileProvider(info.id);
  const use = `provider ${p.provider} with credential ${p.credential}${'executor' in p ? ', on agent nodes with executor: opencode,' : ''}`;
  return `${SKILL}\n\n## This session\n\nToday is ${new Date().toISOString().slice(0, 10)}. You run on ${info.label} (${info.model}). Agent profiles you write should use ${use} unless the person asks otherwise.`;
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
  o: { messages: Message[]; text: string; provider?: BuilderProviderId; model?: string; signal?: AbortSignal },
): Promise<{ messages: Message[]; event: BuilderEvent; provider: BuilderProviderId; model: string; usage: Usage }> {
  const { provider, info } = await providerFor(ctx, workspaceId, o.provider, o.model);
  const messages = structuredClone(o.messages);
  // After tool results the transcript ends on a user message; the person's words join it.
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text: o.text });
  else messages.push({ role: 'user', content: [{ type: 'text', text: o.text }] });

  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: null };
  for (let call = 0; call < MAX_CALLS; call++) {
    const res = await provider.complete({ model: info.model, system: system(info), messages, tools: TOOLS, maxTokens: MAX_OUTPUT_TOKENS, signal: o.signal });
    usage = addUsage(usage, res.usage);
    messages.push({ role: 'assistant', content: res.content.length ? res.content : [{ type: 'text', text: '(no reply)' }] });
    const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return { messages, event: { kind: 'text' }, provider: info.id, model: info.model, usage };

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
        } else if (u.name === 'propose_tool') {
          const r = await checkToolProposal(ctx, workspaceId, input.tool);
          answer(u.id, `The tool spec is valid. The person now sees ${r.ref} with a Register button${r.credential && !r.credential.set ? `; secret '${r.credential.name}' is not set yet, tell them to set it on the Secrets page` : ''}${r.exists ? '; this adds a new revision of an existing tool, and workflow versions keep their old revision until a new version is published' : ''}. Summarise in a few plain sentences, and say a workflow can only use it after it is registered.`);
          event = { kind: 'tool_proposal', proposal: { tool_use_id: u.id, ref: r.ref, summary: String(input.summary ?? ''), spec: r.spec, ...(r.credential ? { credential: r.credential } : {}), exists: r.exists } };
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
    if (event?.kind === 'questions') return { messages, event, provider: info.id, model: info.model, usage };
    if (event?.kind === 'proposal' || event?.kind === 'tool_proposal') {
      const res2 = await provider.complete({ model: info.model, system: system(info), messages, tools: TOOLS, maxTokens: 2000, signal: o.signal });
      usage = addUsage(usage, res2.usage);
      const text = res2.content.filter((b) => b.type === 'text');
      if (text.length) messages.push({ role: 'assistant', content: text });
      return { messages, event, provider: info.id, model: info.model, usage };
    }
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I stopped after many steps without a draft. Tell me what to focus on, or say "draft it" and I will propose one with my assumptions.' }] });
  return { messages, event: { kind: 'text' }, provider: info.id, model: info.model, usage };
}
