import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Formatted, Markdown } from '../components/Rich';
import { FeedEmpty, type FeedTone } from '../components/ActivityFeed';
import { Icon } from '../icons';
import { Link } from '../router';
import { money, num, StateBadge } from '../ui';
import { TYPE, type PlanNode } from '../components/WorkflowCanvas';
import { argLine, Long, ToolIO, useTranscript, type TranscriptEntry } from './AgentActivity';

export interface RunEvent { seq: number; at: string; kind: string; node_id: string | null; data: Record<string, any> }

export function summarise(ev: RunEvent) {
  const d = ev.data ?? {};
  if (ev.kind === 'run.planned') return `run plan recorded: ${d.ok ? 'no blockers' : `${d.blockers?.length} blocker(s)`}, ${d.nodes?.length ?? 0} nodes`;
  const s = JSON.stringify(d);
  return s === '{}' ? '' : s.length > 160 ? s.slice(0, 159) + '…' : s;
}

/** An event in plain words, with the icon and tone that carry its meaning besides colour. */
export function describe(ev: RunEvent): { icon: string; tone: FeedTone; text: string; group: 'steps' | 'approvals' | 'problems' | 'run' } {
  const n = ev.node_id ?? 'The step';
  switch (ev.kind) {
    case 'run.queued': return { icon: 'clock', tone: 'idle', text: 'Run queued', group: 'run' };
    case 'run.held': return { icon: 'clock', tone: 'wait', text: `Waiting for a free slot on ${ev.data?.repo ?? 'its repository'}: ${ev.data?.running?.length ?? ev.data?.limit} run(s) already working on it (limit ${ev.data?.limit})`, group: 'run' };
    case 'run.started': case 'run.start': return { icon: 'play', tone: 'run', text: 'Run started', group: 'run' };
    case 'run.planned': return { icon: 'approval', tone: 'idle', text: `Run plan recorded: ${ev.data?.ok ? 'no blockers' : `${ev.data?.blockers?.length ?? 0} blocker(s)`}`, group: 'run' };
    case 'run.waiting': return { icon: 'clock', tone: 'wait', text: 'Run is waiting', group: 'run' };
    case 'run.resumed': return { icon: 'play', tone: 'run', text: 'Run resumed', group: 'run' };
    case 'run.succeeded': return { icon: 'check', tone: 'ok', text: 'Run finished', group: 'run' };
    case 'run.failed': return { icon: 'alert', tone: 'bad', text: 'Run failed', group: 'problems' };
    case 'run.cancel': case 'run.cancel_requested': return { icon: 'close', tone: 'wait', text: 'Cancel requested', group: 'run' };
    case 'node.running': return { icon: 'step', tone: 'run', text: `${n} started`, group: 'steps' };
    case 'node.succeeded': return { icon: 'check', tone: 'ok', text: `${n} finished${ev.data?.route !== undefined ? `, chose ${ev.data.route}` : ''}`, group: 'steps' };
    case 'node.failed': return { icon: 'alert', tone: 'bad', text: `${n} failed${ev.data?.error?.message ? `: ${ev.data.error.message}` : ''}`, group: 'problems' };
    case 'node.skipped': return { icon: 'step', tone: 'idle', text: `${n} skipped`, group: 'steps' };
    case 'approval.requested': return { icon: 'gate', tone: 'wait', text: `${n} is waiting for a person to decide`, group: 'approvals' };
    case 'approval.decided': case 'approval.submitted': return { icon: 'check', tone: 'ok', text: `${n} was decided`, group: 'approvals' };
    case 'action.outcome_unknown': return { icon: 'alert', tone: 'bad', text: `${n}: a write has an unknown outcome and needs a person to confirm`, group: 'problems' };
    default: return { icon: 'step', tone: ev.kind.endsWith('failed') ? 'bad' : 'idle', text: ev.kind.replaceAll('.', ' ').replaceAll('_', ' '), group: ev.kind.endsWith('failed') ? 'problems' : 'run' };
  }
}

type Cat = 'msg' | 'tool' | 'approval' | 'problem' | 'other';
type Filter = 'all' | Exclude<Cat, 'other'>;
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['msg', 'Messages'], ['tool', 'Tools'], ['approval', 'Approvals'], ['problem', 'Problems']];

/** The chip's word and colour family; colour always comes with the word. */
const CHIP: Record<string, string> = { message: 'agent', prompt: 'script', reasoning: 'flow', tool: 'tool', approval: 'approval', error: 'bad', step: 'script', run: 'notify', system: 'script', model: 'script', note: 'script', output: 'tool' };
const CHIP_LABEL: Record<string, string> = { message: 'Message', prompt: 'Prompt', reasoning: 'Reasoning', tool: 'Tool', approval: 'Approval', error: 'Error', step: 'Step', run: 'Run', system: 'System', model: 'Model call', note: 'Note', output: 'Result' };

/** One line of the log: a run event or a transcript entry, collapsed to a summary until opened. */
interface Row { key: string; at: number; order: number; kind: string; cat: Cat; title: string; summary: string; right?: string; bad?: boolean; text: string; body: () => ReactNode }
interface Group { node: string; start: number; end: number; rows: Row[] }
type Entry = { group: Group; at: number } | { row: Row; at: number };

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const offset = (ms: number, start: number) => { const s = Math.max(0, Math.round((ms - start) / 1000)); return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const span = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const oneLine = (t?: string, n = 160) => { const s = (t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function eventRow(ev: RunEvent): Row {
  const at = new Date(ev.at).getTime();
  const d = describe(ev);
  const data = ev.data ?? {};
  const base = { key: `e${ev.seq}`, at, order: ev.seq, text: `${ev.kind} ${ev.node_id ?? ''} ${JSON.stringify(data)}`.toLowerCase(), body: () => <EventBody ev={ev} /> };
  switch (ev.kind) {
    case 'node.running': return { ...base, kind: 'step', cat: 'other', title: 'Step started', summary: summarise(ev) };
    case 'node.succeeded': return { ...base, kind: 'step', cat: 'other', title: 'Step finished', summary: data.route !== undefined ? `chose ${data.route}` : '' };
    case 'node.skipped': return { ...base, kind: 'step', cat: 'other', title: 'Step skipped', summary: '' };
    case 'node.failed': return { ...base, kind: 'error', cat: 'problem', title: 'Step failed', summary: oneLine(data.error?.message ?? summarise(ev)), right: 'Failed', bad: true };
    case 'approval.requested': return { ...base, kind: 'approval', cat: 'approval', title: 'Approval requested', summary: oneLine(typeof data.message === 'string' ? data.message : 'waiting for a person to decide') };
    case 'approval.decided': case 'approval.submitted': return { ...base, kind: 'approval', cat: 'approval', title: data.decision ? `Decided: ${String(data.decision)}` : 'Decided', summary: data.by ? `by ${String(data.by)}` : '' };
    default: {
      const cat: Cat = d.group === 'problems' ? 'problem' : d.group === 'approvals' ? 'approval' : 'other';
      return { ...base, kind: cat === 'problem' ? 'error' : cat === 'approval' ? 'approval' : ev.node_id ? 'step' : 'run', cat, title: d.text, summary: '', ...(cat === 'problem' ? { right: 'Problem', bad: true } : {}) };
    }
  }
}

function transcriptRow(e: TranscriptEntry, fallbackAt: number): Row {
  const at = e.at ?? fallbackAt;
  const base = { key: `t${e.node_id}/${e.attempt}/${e.id}`, at, order: e.ord, text: `${e.text ?? ''} ${e.tool ?? ''} ${typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? '')} ${e.output ?? ''} ${e.error ?? ''}`.toLowerCase() };
  switch (e.kind) {
    case 'system': return { ...base, kind: 'system', cat: 'other', title: 'System prompt', summary: `${(e.text?.length ?? 0).toLocaleString()} characters`, body: () => <Markdown className="af-text af-mono" text={e.text ?? ''} /> };
    case 'user': return { ...base, kind: 'prompt', cat: 'msg', title: 'Prompt', summary: oneLine(e.text), body: () => <Long text={e.text ?? ''} /> };
    case 'assistant': return { ...base, kind: 'message', cat: 'msg', title: e.model ?? 'Model', summary: oneLine(e.text), body: () => <Markdown className="af-text" text={e.text ?? ''} /> };
    case 'reasoning': return { ...base, kind: 'reasoning', cat: 'msg', title: 'Reasoning', summary: oneLine(e.text), body: () => <Markdown className="af-text af-soft" text={e.text ?? ''} /> };
    case 'tool': {
      const failed = e.status === 'error';
      const running = e.status === 'running' || e.status === 'pending';
      return { ...base, kind: failed ? 'error' : 'tool', cat: failed ? 'problem' : 'tool', title: e.tool ?? 'tool', summary: argLine(e.input), right: failed ? 'Failed' : running ? 'Running' : undefined, bad: failed, body: () => <ToolIO e={e} dcp={e.tool === 'compress'} /> };
    }
    case 'step': {
      const t = e.tokens ?? {};
      return { ...base, kind: 'model', cat: 'other', title: e.model ?? 'Model call', summary: `${num(t.input ?? null)} in${t.cache_read ? `, ${num(t.cache_read)} cached` : ''}, ${num(t.output ?? null)} out${t.reasoning ? `, ${num(t.reasoning)} reasoning` : ''}`, body: () => <Formatted value={t} plain /> };
    }
    case 'error': return { ...base, kind: 'error', cat: 'problem', title: 'Error', summary: oneLine(e.text), right: 'Failed', bad: true, body: () => <Markdown className="af-text" text={e.text ?? ''} /> };
    default: return { ...base, kind: 'note', cat: 'other', title: e.id === 'dcp' ? 'Context pruning' : 'Note', summary: oneLine(e.text), body: () => <p className="af-text">{e.text}</p> };
  }
}

/** The workflow's mapped input for a step, as the canvas's Input tab shows it. */
const INPUT_KEYS = ['input', 'arguments', 'query', 'for_each', 'payload', 'message', 'destination'];
const mappedInput = (node?: PlanNode) => Object.fromEntries(INPUT_KEYS.filter((k) => node?.def?.[k] !== undefined).map((k) => [k, node!.def![k]]));

/**
 * What a step that is not an agent did, from its attempt: the tool it called (or the step itself) with the input
 * the workflow mapped and the output or error it returned. Agent steps' calls come from their transcript instead.
 */
function attemptRow(a: any, node: PlanNode | undefined, fallbackAt: number): Row | null {
  const type = node?.type;
  if (type === 'agent' || type === 'approval' || !a.started_at) return null;
  const at = new Date(a.ended_at ?? a.started_at).getTime() || fallbackAt;
  const input = mappedInput(node);
  const failed = a.state === 'failed' || !!a.error;
  const running = a.state === 'running';
  const tool = type === 'tool' ? String(node?.def?.tool ?? 'tool') : '';
  const took = a.ended_at ? span(new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) : undefined;
  const result = a.error ? oneLine(a.error.message ?? JSON.stringify(a.error), 120) : a.output !== undefined && a.output !== null ? oneLine(JSON.stringify(a.output), 120) : '';
  return {
    key: `a${a.node_id}/${a.attempt}`, at, order: Number.MAX_SAFE_INTEGER, kind: failed ? 'error' : type === 'tool' ? 'tool' : 'output', cat: failed ? 'problem' : type === 'tool' ? 'tool' : 'other',
    title: tool || 'Output', summary: [Object.keys(input).length ? argLine(input) : '', result ? `→ ${result}` : ''].filter(Boolean).join(' '),
    right: failed ? 'Failed' : running ? 'Running' : took, bad: failed,
    text: `${tool} ${JSON.stringify(input)} ${JSON.stringify(a.output ?? '')} ${JSON.stringify(a.error ?? '')}`.toLowerCase(),
    body: () => (
      <div className="af-io">
        {a.attempt > 1 ? <p className="muted small al-meta">Attempt {a.attempt}</p> : null}
        <div className="af-label">Input</div>
        {Object.keys(input).length ? <Formatted value={input} plain /> : <p className="muted small">The workflow mapped no input for this step; it read the outputs of the steps before it.</p>}
        {a.error ? <><div className="af-label">Error</div><Formatted value={a.error} plain /></> : a.output !== undefined && a.output !== null ? <><div className="af-label">Output</div><Formatted value={a.output} /></> : <p className="muted small">{running ? 'Running. Its output appears here when it finishes.' : 'No output.'}</p>}
      </div>
    ),
  };
}

/** A write the step made through the gateway, from the action ledger. */
function actionRow(x: any): Row {
  const failed = x.state === 'failed' || x.state === 'outcome_unknown';
  return {
    key: `x${x.id}`, at: new Date(x.created_at).getTime(), order: Number.MAX_SAFE_INTEGER - 1, kind: failed ? 'error' : 'tool', cat: failed ? 'problem' : 'tool',
    title: String(x.tool), summary: `${x.effect ?? 'write'} · ${String(x.state).replaceAll('_', ' ')}`, right: failed ? String(x.state).replaceAll('_', ' ') : undefined, bad: failed,
    text: `${x.tool} ${x.state} ${JSON.stringify(x.target ?? '')} ${JSON.stringify(x.receipt ?? '')}`.toLowerCase(),
    body: () => <Formatted value={{ action: x.id, effect: x.effect, state: x.state, ...(x.target !== undefined ? { target: x.target } : {}), ...(x.receipt ? { receipt: x.receipt } : {}), ...(x.error ? { error: x.error } : {}) }} plain />,
  };
}

function EventBody({ ev }: { ev: RunEvent }) {
  const data = ev.data ?? {};
  return (
    <>
      <p className="muted small al-meta"><span className="mono">{ev.kind}</span> · event #{ev.seq}</p>
      {Object.keys(data).length ? <Formatted value={data} plain /> : <p className="muted small">No details were recorded with this event.</p>}
    </>
  );
}

/**
 * The run's activity in one log, newest first: each step is a group holding its events and, for agent steps,
 * its conversation with the model and tool calls; run-wide events sit between the groups in time order.
 * Everything starts collapsed; a group opens to its lines, a line opens to its full detail.
 */
export function ActivityLog({ runId, events, nodes, detail: d, open, focus }: { runId: string; events: RunEvent[]; nodes: PlanNode[]; detail: any; open: boolean; focus?: string | null }) {
  const { entries: transcript, enabled } = useTranscript(runId, open);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) => setOpened((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  useEffect(() => {
    if (!focus) return;
    setOpened((s) => new Set(s).add(`g:${focus}`));
    requestAnimationFrame(() => document.getElementById(`al-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [focus]);

  const start = useMemo(() => {
    const first = events[0] ? new Date(events[0].at).getTime() : undefined;
    const t = transcript.find((e) => e.at)?.at;
    return Math.min(first ?? Infinity, t ?? Infinity, d.run.created_at ? new Date(d.run.created_at).getTime() : Infinity);
  }, [events, transcript, d.run.created_at]);

  // Every step with something to show becomes a group; events with no step stay on their own.
  const all = useMemo(() => {
    const groups = new Map<string, Group>();
    const loose: Row[] = [];
    const add = (node: string, row: Row) => {
      const g = groups.get(node) ?? { node, start: row.at, end: row.at, rows: [] };
      g.rows.push(row);
      g.start = Math.min(g.start, row.at);
      g.end = Math.max(g.end, row.at);
      groups.set(node, g);
    };
    for (const ev of events) {
      const row = eventRow(ev);
      if (ev.node_id) add(ev.node_id, row);
      else loose.push(row);
    }
    // An entry without a time takes the time of the entry before it, so it keeps its place.
    let last = Number.isFinite(start) ? start : Date.now();
    for (const e of transcript) {
      const row = transcriptRow(e, last);
      last = row.at;
      add(e.node_id, row);
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const a of (d.attempts ?? []) as any[]) {
      const row = attemptRow(a, byId.get(a.node_id), last);
      if (row) add(a.node_id, row);
    }
    for (const x of (d.actions ?? []) as any[]) if (x.node_id) add(x.node_id, actionRow(x));
    const newest = (a: { at: number; order?: number }, b: { at: number; order?: number }) => b.at - a.at || (b.order ?? 0) - (a.order ?? 0);
    for (const g of groups.values()) g.rows.sort(newest);
    const list: Entry[] = [...[...groups.values()].map((g) => ({ group: g, at: g.start })), ...loose.map((r) => ({ row: r, at: r.at, order: r.order }))];
    return list.sort(newest);
  }, [events, transcript, start, nodes, d.attempts, d.actions]);

  const needle = q.trim().toLowerCase();
  const match = (r: Row) => (filter === 'all' || r.cat === filter) && (!needle || r.text.includes(needle) || r.title.toLowerCase().includes(needle));
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, msg: 0, tool: 0, approval: 0, problem: 0 };
    for (const e of all) for (const r of 'group' in e ? e.group.rows : [e.row]) { c.all++; if (r.cat !== 'other') c[r.cat]++; }
    return c;
  }, [all]);
  const shown = all
    .map((e) => ('group' in e ? { ...e, rows: e.group.rows.filter((r) => match(r) || (needle !== '' && e.group.node.toLowerCase().includes(needle) && filter === 'all')) } : e))
    .filter((e) => ('group' in e ? e.rows.length > 0 : match(e.row)));
  const groupIds = all.flatMap((e) => ('group' in e ? [`g:${e.group.node}`] : []));
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));

  if (!all.length) return <FeedEmpty title="Waiting for the first event" text="Steps starting and finishing, agent messages and tool calls, approvals and problems appear here as the run goes, newest at the top." />;
  return (
    <div className="aa">
      <div className="aa-tools">
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map(([f, label]) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}<span className="aa-n"> {counts[f]}</span></button>)}
        </div>
        <label className="aa-q"><Icon name="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps, tools, text" aria-label="Search the activity log" autoComplete="off" /></label>
        <span className="al-grow" />
        <span className="muted small">Newest first</span>
        <button type="button" className="small" onClick={() => setOpened(new Set(groupIds))}>Expand steps</button>
        <button type="button" className="small" onClick={() => setOpened(new Set())}>Collapse all</button>
      </div>
      {!enabled ? <p className="muted small aa-note">Agent transcripts are turned off on this server, so agent steps show their events only.</p> : null}
      {!shown.length ? <FeedEmpty title="Nothing matches" text="Try a broader search, or show every kind of activity." action="Clear filters" onAction={() => { setFilter('all'); setQ(''); }} /> : (
        <ol className="al" aria-label="Run activity, newest first">
          {open ? (
            <li className="al-entry al-now"><span className="al-off run">now</span><span className="al-rail"><span className="al-dot ring" /></span><span className="muted small al-live">Live. New activity appears here at the top.</span></li>
          ) : null}
          {shown.map((e) => 'group' in e
            ? <GroupView key={`g:${e.group.node}`} group={e.group} rows={e.rows} start={start} type={typeOf.get(e.group.node)} detail={d} running={open} opened={opened} toggle={toggle} />
            : <LooseView key={e.row.key} row={e.row} start={start} opened={opened} toggle={toggle} />)}
        </ol>
      )}
    </div>
  );
}

function Chip({ kind }: { kind: string }) {
  return <span className={`al-chip c-${CHIP[kind] ?? 'script'}`}>{CHIP_LABEL[kind] ?? kind}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg className={`al-chev${open ? ' open' : ''}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;
}

function Stamp({ at, start }: { at: number; start: number }) {
  return <span className="al-off"><span>{offset(at, start)}</span><span className="muted">{clock(at)}</span></span>;
}

function GroupView({ group: g, rows, start, type, detail: d, running, opened, toggle }: { group: Group; rows: Row[]; start: number; type?: string; detail: any; running: boolean; opened: Set<string>; toggle: (k: string) => void }) {
  const k = `g:${g.node}`;
  const isOpen = opened.has(k);
  const attempts = (d.attempts as any[]).filter((a) => a.node_id === g.node);
  const state: string = attempts.at(-1)?.state ?? (rows.some((r) => r.kind === 'approval') ? 'waiting' : 'pending');
  const live = running && (state === 'running' || state === 'waiting');
  const end = live ? Date.now() : g.end;
  const tools = g.rows.filter((r) => r.cat === 'tool' || (r.cat === 'problem' && r.kind === 'error' && /^[tax]/.test(r.key))).length;
  const msgs = g.rows.filter((r) => r.kind === 'message').length;
  const problems = g.rows.filter((r) => r.cat === 'problem').length;
  const summary = [plural(g.rows.length, 'event'), tools ? plural(tools, 'tool call') : '', msgs ? plural(msgs, 'message') : ''].filter(Boolean).join(' · ');
  const t = TYPE[type ?? ''];
  // A subworkflow step links to the run it started (one per round in a loop), as the canvas does.
  const childRuns: string[] = type === 'subworkflow'
    ? [...new Set([...((d.children ?? []) as any[]).filter((c) => c.parent_node_id === g.node).map((c) => String(c.id)), ...attempts.map((a) => a.output?.run_id).filter((x): x is string => typeof x === 'string')])]
    : [];
  return (
    <li className="al-entry" id={`al-${g.node}`}>
      <Stamp at={g.start} start={start} />
      <span className="al-rail"><span className={`al-dot s-${state}`} /></span>
      <div className="al-card">
        <div className="al-headrow">
        <button type="button" className="al-head" aria-expanded={isOpen} onClick={() => toggle(k)}>
          <Chevron open={isOpen} />
          {t ? <span className={`al-chip c-${type === 'agent' ? 'agent' : type === 'tool' ? 'tool' : 'script'}`}>{t.label}</span> : type === 'approval' ? <span className="al-chip c-approval">Approval</span> : null}
          <b className="mono al-node">{g.node}</b>
          <span className="al-grow" />
          {problems ? <span className="al-pill bad">{plural(problems, 'problem')}</span> : null}
          <span className="muted small">{summary}</span>
          <StateBadge state={state} />
          <span className="mono small al-dur">{span(end - g.start)}</span>
        </button>
        {childRuns.map((id, i) => (
          <Link key={id} to={`/ui/runs/${encodeURIComponent(id)}`} className="al-child small" title={`Open the run this step started: ${id}`}>
            <Icon name="subworkflow" size={14} />{childRuns.length > 1 ? `Child run ${i + 1}` : 'Open child run'}<Icon name="chevron-right" size={14} />
          </Link>
        ))}
        </div>
        {isOpen ? (
          <div className="al-body">
            <GroupNote node={g.node} type={t?.label ?? type} attempts={attempts.length} rows={g.rows} detail={d} />
            <ol className="al-rows">
              {rows.map((r) => <RowView key={r.key} row={r} start={start} opened={opened} toggle={toggle} />)}
            </ol>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** What the step cost and used. A number the run did not report says so instead of showing zero. */
function GroupNote({ node, type, attempts, rows, detail: d }: { node: string; type?: string; attempts: number; rows: Row[]; detail: any }) {
  const models = [...new Set(rows.filter((r) => r.kind === 'message' || r.kind === 'model').map((r) => r.title).filter((m) => m !== 'Model' && m !== 'Model call'))];
  const calls = rows.filter((r) => r.kind === 'model');
  const usage = ((d.usage?.records ?? []) as any[]).filter((x) => x.node_id === node);
  const costs = usage.filter((x) => typeof x.cost === 'number');
  const tokensIn = usage.filter((x) => typeof x.input_tokens === 'number');
  const parts = [
    type,
    attempts > 1 ? `${attempts} attempts` : attempts === 1 ? '1 attempt' : '',
    models.join(', '),
    calls.length ? plural(calls.length, 'model call') : '',
    tokensIn.length ? `${num(tokensIn.reduce((n, x) => n + x.input_tokens, 0))} tokens in, ${num(usage.reduce((n, x) => n + (x.output_tokens ?? 0), 0))} out` : usage.length ? 'tokens unavailable' : '',
    usage.length ? (costs.length ? money(costs.reduce((n, x) => n + x.cost, 0)) : 'cost unavailable') : '',
  ].filter(Boolean);
  return parts.length ? <p className="al-note muted small">{parts.join(' · ')}</p> : null;
}

function RowView({ row: r, start, opened, toggle }: { row: Row; start: number; opened: Set<string>; toggle: (k: string) => void }) {
  const isOpen = opened.has(r.key);
  return (
    <li className="al-row">
      <button type="button" className="al-line" aria-expanded={isOpen} onClick={() => toggle(r.key)}>
        <Chevron open={isOpen} />
        <span className="mono small muted" title={clock(r.at)}>{offset(r.at, start)}</span>
        <Chip kind={r.kind} />
        <span className="al-text"><b className={r.kind === 'tool' || r.kind === 'error' ? 'mono' : undefined}>{r.title}</b> <span className="muted">{r.summary}</span></span>
        <span className={`small al-right${r.bad ? ' bad-text' : ' muted'}`}>{r.right ?? ''}</span>
      </button>
      {isOpen ? <div className="al-detail"><p className="muted small al-meta">At {clock(r.at)}</p>{r.body()}</div> : null}
    </li>
  );
}

function LooseView({ row: r, start, opened, toggle }: { row: Row; start: number; opened: Set<string>; toggle: (k: string) => void }) {
  const isOpen = opened.has(r.key);
  return (
    <li className="al-entry">
      <Stamp at={r.at} start={start} />
      <span className="al-rail"><span className={`al-dot small${r.bad ? ' s-failed' : ''}`} /></span>
      <div className="al-loose">
        <button type="button" className="al-line" aria-expanded={isOpen} onClick={() => toggle(r.key)}>
          <Chevron open={isOpen} />
          <Chip kind={r.kind} />
          <span className="al-text"><b>{r.title}</b> <span className="muted">{r.summary}</span></span>
        </button>
        {isOpen ? <div className="al-detail loose">{r.body()}</div> : null}
      </div>
    </li>
  );
}
