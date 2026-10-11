import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Formatted, Markdown } from '../components/Rich';
import { Feed, FeedEmpty, FeedItem, FeedSkeleton, offsetOf, type FeedTone } from '../components/ActivityFeed';
import { Icon } from '../icons';
import { money, num, Panel } from '../ui';
import type { PlanNode } from '../components/WorkflowCanvas';

/** One transcript entry as the API returns it (src/agents/transcript.ts). */
export interface TranscriptEntry {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'reasoning' | 'tool' | 'step' | 'error' | 'note';
  node_id: string;
  attempt: number;
  ord: number;
  version: number;
  text?: string;
  tool?: string;
  status?: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  model?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cache_read?: number; cache_write?: number };
  at?: number;
}

const key = (e: TranscriptEntry) => `${e.node_id}/${e.attempt}/${e.id}`;

/** Follows a run's agent transcripts: every second while the run is open, once more after it ends. */
export function useTranscript(runId: string, open: boolean) {
  const [entries, setEntries] = useState<Map<string, TranscriptEntry>>(new Map());
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const cursor = useRef(0);
  useEffect(() => {
    cursor.current = 0;
    setEntries(new Map());
    setLoaded(false);
  }, [runId]);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<{ enabled: boolean; entries: TranscriptEntry[]; cursor: number }>(`/v1/runs/${encodeURIComponent(runId)}/transcript?after=${cursor.current}`);
        if (stop) return;
        setEnabled(r.enabled);
        setLoaded(true);
        if (r.entries.length) {
          cursor.current = r.cursor;
          setEntries((m) => {
            const next = new Map(m);
            for (const e of r.entries) next.set(key(e), e);
            return next;
          });
        }
        // A full page means more are waiting; ask again at once.
        if (r.entries.length >= 5000) return void (timer = setTimeout(tick, 0));
      } catch {
        /* try again on the next tick */
      }
      if (!stop && open) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runId, open]);
  const list = useMemo(() => [...entries.values()].sort((a, b) => a.ord - b.ord), [entries]);
  return { entries: list, enabled, loaded };
}

type Filter = 'all' | 'messages' | 'tools' | 'reasoning' | 'errors';
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['messages', 'Messages'], ['tools', 'Tool calls'], ['reasoning', 'Reasoning'], ['errors', 'Errors']];
const kindOf = (e: TranscriptEntry): Filter | 'system' | 'model' => (e.kind === 'user' || e.kind === 'assistant' ? 'messages' : e.kind === 'tool' ? 'tools' : e.kind === 'reasoning' ? 'reasoning' : e.kind === 'error' ? 'errors' : e.kind === 'system' ? 'system' : 'model');
const haystack = (e: TranscriptEntry) => `${e.text ?? ''} ${e.tool ?? ''} ${typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? '')} ${e.output ?? ''} ${e.error ?? ''}`.toLowerCase();

/** A feed block: one entry, or a run of consecutive tool calls shown together. */
type Block = { key: string; entries: TranscriptEntry[] };
function blocks(list: TranscriptEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of list) {
    const last = out.at(-1);
    if (e.kind === 'tool' && last && last.entries[0]!.kind === 'tool') last.entries.push(e);
    else out.push({ key: key(e), entries: [e] });
  }
  return out;
}

function useAfter(wait: boolean, ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!wait) return setLate(false);
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [wait, ms]);
  return late;
}

/** Agent steps' conversations with their model: prompts, replies, reasoning and tool calls, live. */
export function AgentActivity({ runId, nodes, detail: d, open, node, onNode, onEvents }: { runId: string; nodes: PlanNode[]; detail: any; open: boolean; node: string | null; onNode: (n: string) => void; onEvents?: () => void }) {
  const { entries, enabled, loaded } = useTranscript(runId, open);
  const agentIds = useMemo(() => {
    const ids = nodes.filter((n) => n.type === 'agent').map((n) => n.id);
    for (const e of entries) if (!ids.includes(e.node_id)) ids.push(e.node_id);
    return ids;
  }, [nodes, entries]);
  const shown = node && agentIds.includes(node) ? node : (agentIds.find((id) => entries.some((e) => e.node_id === id && e.kind !== 'system')) ?? agentIds[0] ?? null);
  const mine = entries.filter((e) => e.node_id === shown);
  const attempts = [...new Set(mine.map((e) => e.attempt))].sort((a, b) => a - b);
  const [attempt, setAttempt] = useState<number | null>(null);
  const at = attempt !== null && attempts.includes(attempt) ? attempt : (attempts.at(-1) ?? 1);
  const list = mine.filter((e) => e.attempt === at);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [newestFirst, setNewestFirst] = useState(false);
  const needle = q.trim().toLowerCase();
  const visible = list.filter((e) => (filter === 'all' || kindOf(e) === filter || (filter === 'messages' && kindOf(e) === 'model') || (filter === 'errors' && e.kind === 'tool' && e.status === 'error')) && (!needle || haystack(e).includes(needle)));
  const feed = useMemo(() => { const b = blocks(visible); return newestFirst ? b.reverse() : b; }, [visible.length, visible.at(-1)?.version, newestFirst, filter, needle, shown, at]);

  // Live tail: follow the newest entry unless the reader scrolled away; offer a way back.
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onScroll = () => { const f = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160; follow.current = f; setFollowing(f); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (open && follow.current && !newestFirst && list.length) end.current?.scrollIntoView({ block: 'end' });
  }, [open, newestFirst, list.length, list.at(-1)?.version]);
  // Entries that arrive after the first paint fade in; the first batch does not.
  const seen = useRef<Set<string>>(new Set());
  const fresh = (k: string) => seen.current.size > 0 && !seen.current.has(k);
  useEffect(() => { for (const e of list) seen.current.add(key(e)); });
  useEffect(() => { seen.current = new Set(); }, [shown, at, runId]);
  const slow = useAfter(!loaded, 100);

  if (!agentIds.length) return <FeedEmpty title="No agent steps in this run" text="This workflow has no agent steps, so there is no conversation to show. Steps that call tools or run code are in the event log." action="Open the event log" onAction={onEvents} />;
  if (!enabled) return <FeedEmpty title="Agent transcripts are turned off" text="This server does not store what agents say and do. An admin can turn it back on by removing AZHI_AGENT_TRANSCRIPTS=0 and restarting." action="Open the event log" onAction={onEvents} />;
  const state = (d.attempts as any[]).filter((a) => a.node_id === shown).at(-1);
  const running = state?.state === 'running';
  const tools = list.filter((e) => e.kind === 'tool');
  const steps = list.filter((e) => e.kind === 'step');
  const sum = (f: (t: NonNullable<TranscriptEntry['tokens']>) => number | undefined) => steps.reduce((n, s) => n + (f(s.tokens ?? {}) ?? 0), 0);
  const cost = ((d.usage?.records ?? []) as any[]).filter((x) => x.node_id === shown && typeof x.cost === 'number').reduce((t, x) => t + x.cost, 0);
  const start = list.find((e) => e.at)?.at;
  const last = list.at(-1)?.at;
  const elapsed = start && last ? Math.max(0, Math.round((last - start) / 1000)) : undefined;
  const maxTokens = Math.max(1, ...steps.map((s) => (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0)));
  const failed = tools.filter((t) => t.status === 'error').length;
  const filtered = filter !== 'all' || needle !== '';
  return (
    <div className="aa">
      <div className="aa-top">
        <div className="agent-picker" role="group" aria-label="Agent step">
          {agentIds.map((id) => {
            const st = (d.attempts as any[]).filter((a) => a.node_id === id).at(-1)?.state;
            return (
              <button key={id} type="button" aria-pressed={id === shown} onClick={() => { onNode(id); setAttempt(null); setFilter('all'); setQ(''); }}>
                <StateMark state={st} />{id}
              </button>
            );
          })}
        </div>
        <div className="aa-right">
          {attempts.length > 1 ? <label className="small muted">Attempt <select value={at} onChange={(e) => setAttempt(Number(e.target.value))}>{attempts.map((a) => <option key={a} value={a}>{a}</option>)}</select></label> : null}
          {running ? <span className="aa-live"><span className="aa-live-dot" aria-hidden="true" />Live</span> : null}
        </div>
      </div>

      <dl className="aa-stats" aria-label="Summary of this step" aria-live="polite">
        <div><dt>Tool calls</dt><dd>{tools.length}{failed ? <span className="bad-text"> · {failed} failed</span> : null}</dd></div>
        <div><dt>Model calls</dt><dd>{steps.length}</dd></div>
        <div><dt>Tokens in / out</dt><dd>{steps.length ? `${num(sum((t) => t.input))} / ${num(sum((t) => t.output))}` : '—'}</dd></div>
        <div><dt>Cached</dt><dd>{steps.length ? num(sum((t) => t.cache_read)) : '—'}</dd></div>
        <div><dt>Cost</dt><dd>{cost ? money(cost) : '—'}</dd></div>
        <div><dt>Elapsed</dt><dd>{elapsed === undefined ? '—' : `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`}</dd></div>
      </dl>

      <div className="aa-tools">
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map(([f, label]) => {
            const n = f === 'all' ? list.length : list.filter((e) => kindOf(e) === f || (f === 'errors' && e.kind === 'tool' && e.status === 'error')).length;
            return <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}{f !== 'all' ? <span className="aa-n"> {n}</span> : null}</button>;
          })}
        </div>
        <label className="aa-q"><Icon name="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this step" aria-label="Search this step's activity" autoComplete="off" /></label>
        <div className="seg" role="group" aria-label="Order">
          <button type="button" aria-pressed={!newestFirst} onClick={() => setNewestFirst(false)}>Oldest first</button>
          <button type="button" aria-pressed={newestFirst} onClick={() => setNewestFirst(true)}>Newest first</button>
        </div>
      </div>

      {!list.length ? (
        !loaded ? (slow ? <FeedSkeleton /> : null)
          : running || state?.state === 'pending' || !state
            ? <FeedEmpty title="Waiting for the agent" text="It has not started talking to its model yet. Entries appear here as they happen." action="Open the event log" onAction={onEvents} />
            : <FeedEmpty title="No transcript was recorded for this step" text="It ran before transcripts were stored, or its harness did not report one. The event log still shows what happened." action="Open the event log" onAction={onEvents} />
      ) : !feed.length ? (
        <FeedEmpty title="No entries match" text="Try a broader search, or show everything this step did." action="Clear filters" onAction={() => { setFilter('all'); setQ(''); }} />
      ) : (
        <>
          <Feed label={`Activity of ${shown}`}>
            {feed.map((b) => <Block key={b.key} block={b} start={start} maxTokens={maxTokens} fresh={fresh(b.key)} />)}
            {state?.error && !running && filter === 'all' && !needle ? (
              <FeedItem icon="alert" tone="bad" offset={offsetOf(last, start)}><div className="af-card bad"><div className="af-head"><b>Step failed</b></div><p className="af-text">{state.error.class}: {state.error.message}</p></div></FeedItem>
            ) : null}
          </Feed>
          <div ref={end} />
          {running && !following && !newestFirst ? <button type="button" className="aa-jump" onClick={() => { follow.current = true; end.current?.scrollIntoView({ block: 'end' }); }}><Icon name="down" size={16} />Jump to latest</button> : null}
        </>
      )}
      {filtered && feed.length ? <p className="muted small aa-note">Showing {visible.length} of {list.length} entries. <button type="button" className="link small" onClick={() => { setFilter('all'); setQ(''); }}>Clear filters</button></p> : null}
    </div>
  );
}

/** A step's state as an icon and a word for screen readers, never colour alone. */
function StateMark({ state }: { state?: string }) {
  if (state === 'running') return <span className="aa-run" role="img" aria-label="running" />;
  if (state === 'succeeded') return <span className="aa-state ok" role="img" aria-label="succeeded"><Icon name="check" size={12} /></span>;
  if (state === 'failed') return <span className="aa-state bad" role="img" aria-label="failed"><Icon name="close" size={12} /></span>;
  return null;
}

const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

function Block({ block, start, maxTokens, fresh }: { block: Block; start?: number; maxTokens: number; fresh: boolean }) {
  const e = block.entries[0]!;
  const off = offsetOf(e.at, start);
  const title = time(e.at);
  const item = (icon: string, tone: FeedTone, body: ReactNode) => <FeedItem icon={icon} tone={tone} offset={off} offsetTitle={title} fresh={fresh}>{body}</FeedItem>;
  switch (e.kind) {
    case 'system':
      return item('lock', 'idle', (
        <details className="af-quiet">
          <summary><b>System prompt</b><span className="muted small">{e.text?.length?.toLocaleString() ?? 0} characters</span></summary>
          <Markdown className="af-text af-mono" text={e.text ?? ''} />
        </details>
      ));
    case 'user':
      return item('person', 'prompt', <div className="af-card"><div className="af-head"><b>Prompt</b><span className="muted small">{title}</span></div><Long text={e.text ?? ''} /></div>);
    case 'assistant':
      return item('agent', 'agent', <div className="af-card"><div className="af-head"><b>Model</b>{e.model ? <span className="muted small">{e.model}</span> : null}<span className="muted small">{title}</span></div><Markdown className="af-text" text={e.text ?? ''} /></div>);
    case 'reasoning':
      return item('think', 'think', (
        <details className="af-quiet">
          <summary><b>Reasoning</b><span className="muted small af-preview">{(e.text ?? '').replace(/\s+/g, ' ').slice(0, 110)}</span></summary>
          <Markdown className="af-text af-soft" text={e.text ?? ''} />
        </details>
      ));
    case 'tool': {
      const failed = block.entries.some((t) => t.status === 'error');
      const running = block.entries.some((t) => t.status === 'running' || t.status === 'pending');
      return item('tool', failed ? 'bad' : running ? 'run' : 'tool', (
        <div className="af-card af-tools-card">
          {block.entries.length > 1 ? <div className="af-head"><b>{block.entries.length} tool calls</b><span className="muted small">{block.entries.filter((t) => t.status === 'completed').length} done{failed ? `, ${block.entries.filter((t) => t.status === 'error').length} failed` : ''}{running ? ', running' : ''}</span></div> : null}
          {block.entries.map((t) => <ToolLine key={key(t)} e={t} single={block.entries.length === 1} />)}
        </div>
      ));
    }
    case 'step': {
      const t = e.tokens ?? {};
      const inTok = t.input ?? 0, cached = Math.min(t.cache_read ?? 0, inTok), out = t.output ?? 0;
      const w = (n: number) => `${Math.max(n ? 2 : 0, (n / maxTokens) * 100)}%`;
      return item('step', 'idle', (
        <div className="af-step muted small">
          <span>Model call{e.model ? ` (${e.model})` : ''}: {num(t.input ?? null)} in{t.cache_read ? `, ${num(t.cache_read)} cached` : ''}, {num(t.output ?? null)} out{t.reasoning ? `, ${num(t.reasoning)} reasoning` : ''}</span>
          <span className="af-bar" aria-hidden="true"><i className="in" style={{ width: w(inTok - cached) }} /><i className="cache" style={{ width: w(cached) }} /><i className="out" style={{ width: w(out) }} /></span>
        </div>
      ));
    }
    case 'error':
      return item('alert', 'bad', <div className="af-card bad"><div className="af-head"><b>Error</b><span className="muted small">{title}</span></div><Markdown className="af-text" text={e.text ?? ''} /></div>);
    default:
      return item('step', 'idle', <div className="af-step muted small">{e.text}</div>);
  }
}

/** One tool call: a line with its name, arguments and state; open it for the input and the result. */
function ToolLine({ e, single }: { e: TranscriptEntry; single: boolean }) {
  const tone = e.status === 'completed' ? 'ok' : e.status === 'error' ? 'bad' : 'run';
  return (
    <details className={`af-tool ${tone}`} open={e.status === 'error' && single}>
      <summary>
        <span className={`af-st ${tone}`} role="img" aria-label={e.status === 'completed' ? 'done' : e.status === 'error' ? 'failed' : 'running'}>{tone === 'ok' ? <Icon name="check" size={12} /> : tone === 'bad' ? <Icon name="close" size={12} /> : null}</span>
        <b className="mono">{e.tool ?? 'tool'}</b>
        <span className="muted af-args">{argLine(e.input)}</span>
        <span className="muted small af-time">{time(e.at)}</span>
      </summary>
      <div className="af-io">
        <div className="af-label">Input</div>
        <Formatted value={e.input ?? {}} plain />
        {e.status === 'error' ? <><div className="af-label">Error</div><pre className="json bad">{e.error}</pre></> : e.output !== undefined ? <><div className="af-label">Result</div><Formatted value={e.output} plain /></> : <p className="muted small">Running…</p>}
      </div>
    </details>
  );
}

/** A long prompt shows its start, with the rest a click away. */
function Long({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= 1200 || all) return <Markdown className="af-text" text={text} />;
  return <div className="af-text"><Markdown text={`${text.slice(0, 1200)}…`} /><button type="button" className="link small" onClick={() => setAll(true)}>Show all ({text.length.toLocaleString()} characters)</button></div>;
}

function argLine(input: unknown): string {
  if (input === undefined || input === null) return '';
  const t = typeof input === 'string' ? input : JSON.stringify(input);
  return t === '{}' ? '' : t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

export function AgentActivityPanel(props: Parameters<typeof AgentActivity>[0]) {
  return <Panel><AgentActivity {...props} /></Panel>;
}
