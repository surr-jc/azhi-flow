import { readFileSync } from 'node:fs';
import type { Block, Message, ModelTool, Usage } from '../agents/providers.js';
import { providerFor, type BuilderProviderId } from '../builder/builder.js';
import { AzhiError, ErrorClass } from '../lib/errors.js';
import { checkCall, TOOLS, type ActionPreview, type AssistantDeps, type Caller } from './tools.js';

/**
 * The assistant chat behind the bubble on every mission control page: a model with the assistant
 * skill (skill.md) and the shared tools (tools.ts), run as the person who asks. It answers from the
 * workspace's own state and docs. Actions are proposed, never run: a person confirms each one
 * (POST /v1/assistant/actions). Building a workflow is handed to the workflow builder.
 *
 * Like the builder, the browser keeps the transcript and sends it with each message; the provider
 * and its credential are the builder's (Governance › Secrets).
 */
export interface ActionProposal extends ActionPreview {
  tool_use_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export type AssistantEvent =
  | { kind: 'text' }
  | { kind: 'action_proposal'; proposal: ActionProposal }
  | { kind: 'build_handoff'; handoff: { prompt: string; workflow?: string } };

/** Where the person is in mission control, so "this run" means something. */
export interface PageContext {
  kind: 'run' | 'workflow' | 'dataset' | 'connection' | 'page';
  id?: string;
  path: string;
}

const SKILL = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
/** Model calls per person message: a few lookups, then the answer. */
const MAX_CALLS = 12;
const MAX_OUTPUT_TOKENS = 4000;
const RESULT_CHARS = 60_000;
const PAGE_ID = /^[A-Za-z0-9._@:-]{1,120}$/;
const PAGE_PATH = /^\/ui(?:\/[A-Za-z0-9._@:%-]+)*$/;

const OPEN_BUILDER: ModelTool = {
  name: 'open_builder',
  description: 'Hand a request to create or change a workflow to the workflow builder. The person sees a button that opens the builder with this request filled in.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: 480, description: 'What the person wants, in their words, as the first message to the builder.' },
      workflow: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,99}$', description: 'The slug of the workflow to change; leave out for a new one.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
};

const RANK = { viewer: 0, operator: 1, author: 2, admin: 3, owner: 4 } as const;
const allowed = (p: Caller, role: keyof typeof RANK) => RANK[p.role] >= RANK[role];

/** The tools this person may call; tools above their role are not offered at all. */
export function toolsFor(p: Caller): ModelTool[] {
  return [
    ...TOOLS.filter((t) => allowed(p, t.role)).map((t) => ({ name: t.name, description: t.effect === 'act' ? `[Action: the person confirms before it runs] ${t.description}` : t.description, input_schema: t.input_schema })),
    ...(allowed(p, 'author') ? [OPEN_BUILDER] : []),
  ];
}

/** The page the browser reports, checked: an unexpected value is dropped, never put in the prompt. */
export function checkPage(raw: unknown): PageContext | undefined {
  const o = raw as Partial<PageContext> | undefined;
  if (!o || typeof o.path !== 'string' || !PAGE_PATH.test(o.path) || o.path.length > 200) return undefined;
  if (!['run', 'workflow', 'dataset', 'connection', 'page'].includes(String(o.kind))) return undefined;
  if (o.id !== undefined && (typeof o.id !== 'string' || !PAGE_ID.test(o.id))) return undefined;
  return { kind: o.kind!, ...(o.id ? { id: o.id } : {}), path: o.path };
}

function system(p: Caller, info: { label: string; model: string }, page?: PageContext): string {
  const where = !page
    ? ''
    : page.kind === 'page' || !page.id
      ? ` They are on ${page.path}.`
      : ` They are looking at ${page.kind} \`${page.id}\` (${page.path}); "this ${page.kind}" means it.`;
  return `${SKILL}\n\n## This session\n\nToday is ${new Date().toISOString().slice(0, 10)}. You run on ${info.label} (${info.model}). The person has the role \`${p.role}\`.${where}`;
}

const clip = (s: string) => (s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n…(cut at ${RESULT_CHARS} characters; ask for less, e.g. a smaller limit)` : s);

const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
  output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
  cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0),
  cache_write_tokens: (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0),
  reasoning_tokens: null,
});

/**
 * One person message: appends it to the transcript and runs the model until it answers, proposes an
 * action, or hands a build to the builder.
 */
export async function assistantTurn(
  d: AssistantDeps,
  p: Caller,
  o: { messages: Message[]; text: string; page?: PageContext; provider?: BuilderProviderId; model?: string; signal?: AbortSignal },
): Promise<{ messages: Message[]; event: AssistantEvent; provider: BuilderProviderId; model: string; usage: Usage }> {
  const { provider, info } = await providerFor(d.ctx, p.workspaceId, o.provider, o.model);
  const tools = toolsFor(p);
  const messages = structuredClone(o.messages);
  // After tool results (or a proposed action) the transcript ends on a user message; the person's words join it.
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text: o.text });
  else messages.push({ role: 'user', content: [{ type: 'text', text: o.text }] });
  const done = (event: AssistantEvent) => ({ messages, event, provider: info.id, model: info.model, usage });

  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: null };
  for (let call = 0; call < MAX_CALLS; call++) {
    const res = await provider.complete({ model: info.model, system: system(p, info, o.page), messages, tools, maxTokens: MAX_OUTPUT_TOKENS, signal: o.signal });
    usage = addUsage(usage, res.usage);
    messages.push({ role: 'assistant', content: res.content.length ? res.content : [{ type: 'text', text: '(no reply)' }] });
    const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return done({ kind: 'text' });

    const results: Block[] = [];
    let event: AssistantEvent | undefined;
    const answer = (id: string, content: string, is_error = false) => results.push({ type: 'tool_result', tool_use_id: id, content: clip(content), ...(is_error ? { is_error } : {}) });
    for (const u of uses) {
      try {
        if (res.stop === 'max_tokens') {
          answer(u.id, `Your reply was cut off at ${MAX_OUTPUT_TOKENS} output tokens, so this call is incomplete. Try again with less.`, true);
        } else if (event) {
          answer(u.id, 'Not run: one action or hand-off at a time. Propose this again after the person has answered.', true);
        } else if (u.name === 'open_builder') {
          if (!allowed(p, 'author')) throw new AzhiError(ErrorClass.authorization, `building workflows needs the author role (the person is ${p.role})`);
          const input = u.input as { prompt?: unknown; workflow?: unknown };
          const workflow = typeof input.workflow === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(input.workflow) ? input.workflow : undefined;
          const prompt = String(input.prompt ?? '').trim().slice(0, 480);
          if (!prompt) throw new AzhiError(ErrorClass.invalidInput, 'prompt is required');
          answer(u.id, 'The person now sees a button that opens the workflow builder with this request. Tell them in one sentence.');
          event = { kind: 'build_handoff', handoff: { prompt, ...(workflow ? { workflow } : {}) } };
        } else {
          const { tool, args } = checkCall(p, u.name, u.input);
          if (tool.effect === 'act') {
            const preview = await tool.preview!(d, p, args);
            answer(u.id, `Not run yet. The person sees "${preview.title}" with a Confirm button; it runs only if they press it. Tell them in one sentence what it will do, and do not say it has happened.`);
            event = { kind: 'action_proposal', proposal: { tool_use_id: u.id, tool: tool.name, args, ...preview } };
          } else {
            answer(u.id, JSON.stringify(await tool.run(d, p, args), null, 1) ?? 'null');
          }
        }
      } catch (e) {
        answer(u.id, (e as Error).message, true);
      }
    }
    messages.push({ role: 'user', content: results });
    // A proposal or hand-off gets one more call for the sentence that goes with the card.
    if (event) {
      const res2 = await provider.complete({ model: info.model, system: system(p, info, o.page), messages, tools, maxTokens: 1000, signal: o.signal });
      usage = addUsage(usage, res2.usage);
      const text = res2.content.filter((b) => b.type === 'text');
      if (text.length) messages.push({ role: 'assistant', content: text });
      return done(event);
    }
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I looked a lot up without getting to an answer. Ask me something narrower, for example one run or one workflow.' }] });
  return done({ kind: 'text' });
}
