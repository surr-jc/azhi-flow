import { brief, sourcesOf, type KeySetting } from './stepHelp.js';
import type { PlanNode } from './graph.js';

/**
 * The workflow canvas, read for one concern at a time. Flow is the usual settings on each card;
 * Access shows which credential each step uses and what it may change; Limits shows what stops it;
 * Data shows what flows in and out. The same steps, relabelled.
 */
export type Lens = 'flow' | 'access' | 'limits' | 'data';
export const LENSES: Array<{ id: Lens; label: string; hint: string }> = [
  { id: 'flow', label: 'Flow', hint: 'What each step does.' },
  { id: 'access', label: 'Access', hint: 'Which credential each step uses, and what it may change.' },
  { id: 'limits', label: 'Limits', hint: 'How long each step may run and what it may spend.' },
  { id: 'data', label: 'Data', hint: 'What each step reads and what reads it.' },
];

export interface LensTool { id: string; version: number; effect: string; credential?: string; transport?: { config?: { repos?: string[] } } }
export interface LensContext {
  tools: LensTool[];
  /** Secrets the run plan found missing. */
  missing: Set<string>;
}

const toolOf = (ctx: LensContext, ref: unknown) => (typeof ref === 'string' ? ctx.tools.find((t) => `${t.id}@${t.version}` === ref) : undefined);
const slackTool = (ctx: LensContext) => ctx.tools.find((t) => t.id === 'slack.post-message');
const system = (id: string) => id.split('.')[0]!;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const tokenRow = (ctx: LensContext, credential: string | undefined, label = 'Token'): KeySetting[] =>
  credential ? [{ label, value: `${credential}${ctx.missing.has(credential) ? ' (missing)' : ''}`, keys: [], tone: ctx.missing.has(credential) ? 'warn' : 'ok' }] : [];

/** What a step uses and may change, for the Access lens. */
function access(n: PlanNode, ctx: LensContext): KeySetting[] {
  const def = (n.def ?? {}) as Record<string, any>;
  const rows: KeySetting[] = [];
  switch (n.type) {
    case 'tool': {
      const t = toolOf(ctx, def.tool);
      if (!t) return [{ label: 'Tool', value: 'not registered', keys: [], tone: 'warn' }];
      rows.push({ label: 'Can', value: t.effect === 'read' ? `read ${system(t.id)}` : `change ${system(t.id)}`, keys: [], tone: t.effect === 'read' ? 'ok' : 'warn' }, ...tokenRow(ctx, t.credential));
      if (t.transport?.config?.repos?.length) rows.push({ label: 'Only in', value: t.transport.config.repos.join(', '), keys: [] });
      if (t.effect !== 'read') rows.push({ label: 'Guard', value: def.guard ? 'checked on every call' : 'none', keys: [], tone: def.guard ? 'ok' : 'warn' });
      return rows;
    }
    case 'notify': {
      const t = slackTool(ctx);
      rows.push({ label: 'Can', value: 'send a Slack message', keys: [], tone: 'warn' }, ...tokenRow(ctx, t?.credential), { label: 'Only to', value: brief(def.destination) || 'its destination', keys: [] });
      rows.push({ label: 'Guard', value: def.guard ? 'checked on every message' : 'none', keys: [], tone: def.guard ? 'ok' : 'warn' });
      return rows;
    }
    case 'agent': {
      const ws = def.workspace as Record<string, any> | undefined;
      rows.push({ label: 'Can', value: ws ? (ws.mode === 'write' ? 'edit a checkout' : 'read a checkout') : 'read what it is given', keys: [], tone: ws?.mode === 'write' ? 'warn' : 'ok' });
      if (ws?.credential) rows.push(...tokenRow(ctx, ws.credential, 'Clone token'));
      rows.push({ label: 'Tools', value: brief(def.tools) || 'none', keys: [] });
      if (def.datasets?.length) rows.push({ label: 'Knows', value: brief(def.datasets), keys: [] });
      return rows;
    }
    case 'approval':
      return [{ label: 'Decided by', value: `${def.role ?? 'operator'} or higher`, keys: [] }, { label: 'Shows', value: def.payload ? 'details' : 'no details', keys: [], tone: def.payload ? undefined : 'warn' }];
    case 'script':
      return [{ label: 'Can', value: 'run code in a sandbox', keys: [], tone: 'idle' }, { label: 'Network', value: 'none', keys: [], tone: 'ok' }];
    case 'subworkflow':
      return [{ label: 'Can', value: `run ${brief(def.workflow)}`, keys: [], tone: 'idle' }];
    default:
      return [{ label: 'Can', value: 'nothing outside Azhi', keys: [], tone: 'ok' }];
  }
}

/** What stops a step, for the Limits lens. */
function limits(n: PlanNode): KeySetting[] {
  const def = (n.def ?? {}) as Record<string, any>;
  const rows: KeySetting[] = [{ label: 'Timeout', value: def.timeout ? String(def.timeout) : 'default', keys: [], tone: def.timeout ? undefined : 'idle' }];
  const b = (def.budget ?? {}) as Record<string, number>;
  if (n.type === 'agent') {
    rows.push({ label: 'Tool calls', value: b.max_tool_calls !== undefined ? String(b.max_tool_calls) : 'no limit', keys: [], tone: b.max_tool_calls !== undefined ? 'ok' : 'warn' });
    if (b.max_output_tokens) rows.push({ label: 'Tokens', value: b.max_output_tokens.toLocaleString('en'), keys: [] });
    rows.push({ label: 'Cost', value: b.max_cost_usd ? `$${b.max_cost_usd}` : 'no cap', keys: [], tone: b.max_cost_usd ? 'ok' : 'idle' });
  }
  if (n.type === 'script') {
    const l = (def.limits ?? {}) as Record<string, unknown>;
    if (l.memory_mb) rows.push({ label: 'Memory', value: `${l.memory_mb} MB`, keys: [] });
  }
  if (n.type === 'loop') rows.push({ label: 'At most', value: plural(def.max_iterations ?? 0, 'time'), keys: [] }, { label: 'At the cap', value: String(def.on_max ?? 'fail'), keys: [] });
  if (n.type === 'parallel') rows.push({ label: 'At once', value: String(def.max_concurrency ?? 'default'), keys: [] });
  if (n.type === 'approval') rows.push({ label: 'Waits', value: def.expires_in ? `${def.expires_in}, then ${def.on_expiry ?? 'fail'}` : 'until decided', keys: [], tone: def.expires_in ? undefined : 'warn' });
  const tries = (def.retry as Record<string, unknown> | undefined)?.max_attempts;
  if (n.type !== 'approval' && n.type !== 'condition') rows.push({ label: 'Retry', value: typeof tries === 'number' ? `up to ${plural(tries, 'attempt')}` : 'none', keys: [] });
  return rows;
}

const INPUT_KEYS = ['input', 'arguments', 'query', 'for_each', 'payload', 'message', 'destination'];

function data(n: PlanNode, nodes: PlanNode[]): KeySetting[] {
  const def = (n.def ?? {}) as Record<string, any>;
  const gets = sourcesOf(INPUT_KEYS.map((k) => def[k]));
  const feeds = nodes.filter((x) => x.deps.includes(n.id)).map((x) => x.id);
  const schema = def.output_schema;
  return [
    { label: 'Gets', value: gets.join(', ') || 'nothing from other steps', keys: [] },
    { label: 'Returns', value: typeof schema === 'string' ? schema : schema ? 'inline schema' : 'its output', keys: [] },
    { label: 'Feeds', value: feeds.length ? feeds.join(', ') : 'nothing after it', keys: [] },
  ];
}

export function lensRows(lens: Lens, n: PlanNode, nodes: PlanNode[], ctx: LensContext): KeySetting[] {
  return lens === 'access' ? access(n, ctx) : lens === 'limits' ? limits(n) : lens === 'data' ? data(n, nodes) : [];
}

export interface LensCard { title: string; lines: string[]; tone?: 'ok' | 'warn' | 'idle' }

/** A few plain sentences about the whole workflow for the lens, shown under the canvas. */
export function lensSummary(lens: Lens, nodes: PlanNode[], ctx: LensContext): LensCard[] {
  if (lens === 'access') {
    const writes = new Map<string, string[]>();
    for (const n of nodes) {
      const def = (n.def ?? {}) as Record<string, any>;
      const t = n.type === 'tool' ? toolOf(ctx, def.tool) : undefined;
      const sys = n.type === 'notify' ? 'slack' : t && t.effect !== 'read' ? system(t.id) : undefined;
      if (sys) writes.set(sys, [...(writes.get(sys) ?? []), `${n.id}${def.guard ? ' (guarded)' : ' (no guard)'}`]);
    }
    const agents = nodes.filter((n) => n.type === 'agent');
    const editing = agents.filter((n) => ((n.def as { workspace?: { mode?: string } } | undefined)?.workspace?.mode) === 'write');
    const secrets = new Set<string>();
    for (const n of nodes) {
      const def = (n.def ?? {}) as Record<string, any>;
      const t = n.type === 'tool' ? toolOf(ctx, def.tool) : n.type === 'notify' ? slackTool(ctx) : undefined;
      if (t?.credential) secrets.add(t.credential);
      if (def.workspace?.credential) secrets.add(def.workspace.credential);
    }
    const gone = [...secrets].filter((s) => ctx.missing.has(s));
    return [
      writes.size
        ? { title: 'Changes things outside Azhi', lines: [...writes].map(([sys, steps]) => `${sys}: ${steps.join(', ')}`), tone: [...writes.values()].some((s) => s.some((x) => x.includes('no guard'))) ? 'warn' : 'ok' }
        : { title: 'Changes things outside Azhi', lines: ['Nothing. Every step only reads.'], tone: 'ok' },
      { title: 'Agents', lines: agents.length ? [`${plural(agents.length, 'agent')}: ${editing.length ? `${plural(editing.length, 'step')} can edit a checkout` : 'all work in read-only checkouts or on what they are given'}.`] : ['No agent steps.'], tone: editing.length ? 'warn' : 'ok' },
      { title: 'Secrets', lines: secrets.size ? [`${secrets.size - gone.length} of ${secrets.size} set${gone.length ? `; missing: ${gone.join(', ')}` : ''}.`] : ['None used.'], tone: gone.length ? 'warn' : 'ok' },
    ];
  }
  if (lens === 'limits') {
    const agents = nodes.filter((n) => n.type === 'agent');
    const calls = agents.reduce((a, n) => a + (((n.def as { budget?: { max_tool_calls?: number } })?.budget?.max_tool_calls) ?? 0), 0);
    const cost = agents.reduce((a, n) => a + (((n.def as { budget?: { max_cost_usd?: number } })?.budget?.max_cost_usd) ?? 0), 0);
    const open = agents.filter((n) => ((n.def as { budget?: { max_tool_calls?: number } })?.budget?.max_tool_calls) === undefined).map((n) => n.id);
    const noTimeout = nodes.filter((n) => !(n.def as { timeout?: string } | undefined)?.timeout && ['agent', 'script', 'loop', 'subworkflow'].includes(n.type)).map((n) => n.id);
    return [
      { title: 'Agent budget', lines: agents.length ? [`Up to ${calls} tool calls${cost ? ` and $${cost}` : ''} across ${plural(agents.length, 'agent')}.`, ...(open.length ? [`No tool-call limit: ${open.join(', ')}.`] : [])] : ['No agent steps.'], tone: open.length ? 'warn' : 'ok' },
      { title: 'Timeouts', lines: noTimeout.length ? [`Default timeout applies to ${noTimeout.join(', ')}.`] : ['Every long-running step has its own timeout.'], tone: noTimeout.length ? 'idle' : 'ok' },
      { title: 'Waits for a person', lines: nodes.filter((n) => n.type === 'approval').map((n) => `${n.id}: ${(n.def as { expires_in?: string } | undefined)?.expires_in ?? 'until decided'}`).concat(nodes.some((n) => n.type === 'approval') ? [] : ['No approval steps.']), tone: 'idle' },
    ];
  }
  if (lens === 'data') {
    const readers = new Map<string, string[]>();
    for (const n of nodes) for (const s of sourcesOf(INPUT_KEYS.map((k) => ((n.def ?? {}) as Record<string, unknown>)[k]))) if (s.startsWith('input ') || s.startsWith('config ')) readers.set(s, [...(readers.get(s) ?? []), n.id]);
    const sets = [...new Set(nodes.flatMap((n) => (Array.isArray((n.def as { datasets?: unknown } | undefined)?.datasets) ? ((n.def as { datasets: string[] }).datasets) : [])))];
    return [
      { title: 'Inputs and config', lines: readers.size ? [...readers].map(([k, steps]) => `${k}: ${steps.join(', ')}`) : ['No step reads an input.'], tone: 'idle' },
      { title: 'Datasets', lines: sets.length ? sets : ['None read.'], tone: 'idle' },
      { title: 'Ends at', lines: nodes.filter((n) => !nodes.some((x) => x.deps.includes(n.id))).map((n) => n.id), tone: 'idle' },
    ];
  }
  return [];
}
