import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Badge, Json, num, Panel } from '../ui';
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

/** Agent steps' conversations with their model: prompts, replies, reasoning and tool calls, live. */
export function AgentActivity({ runId, nodes, detail: d, open, node, onNode }: { runId: string; nodes: PlanNode[]; detail: any; open: boolean; node: string | null; onNode: (n: string) => void }) {
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
  const follow = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  // Keep the newest entry in view while the step runs, unless the reader has scrolled up.
  useEffect(() => {
    const onScroll = () => (follow.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (open && follow.current && list.length) end.current?.scrollIntoView({ block: 'end' });
  }, [open, list.length, list.at(-1)?.version]);

  if (!agentIds.length) return <p className="muted">This run has no agent steps.</p>;
  if (!enabled) return <p className="muted">Agent transcripts are turned off on this server (AZHI_AGENT_TRANSCRIPTS=0).</p>;
  const state = (d.attempts as any[]).filter((a) => a.node_id === shown).at(-1);
  const tools = list.filter((e) => e.kind === 'tool');
  const steps = list.filter((e) => e.kind === 'step');
  const sum = (f: (t: NonNullable<TranscriptEntry['tokens']>) => number | undefined) => steps.reduce((n, s) => n + (f(s.tokens ?? {}) ?? 0), 0);
  return (
    <>
      <div className="agent-picker" role="group" aria-label="Agent step">
        {agentIds.map((id) => {
          const st = (d.attempts as any[]).filter((a) => a.node_id === id).at(-1)?.state;
          return (
            <button key={id} type="button" aria-pressed={id === shown} onClick={() => { onNode(id); setAttempt(null); }}>
              {id}{st === 'running' ? <span className="dot run" aria-label="running" /> : null}
            </button>
          );
        })}
        {attempts.length > 1 ? (
          <label className="small muted" style={{ marginLeft: 'auto' }}>
            Attempt{' '}
            <select value={at} onChange={(e) => setAttempt(Number(e.target.value))}>
              {attempts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <p className="muted small">
        {list.length ? `${tools.length} tool call${tools.length === 1 ? '' : 's'}, ${steps.length} model call${steps.length === 1 ? '' : 's'}${steps.length ? `, ${num(sum((t) => t.input))} tokens in and ${num(sum((t) => t.output))} out` : ''}.` : null}
        {state?.state === 'running' ? ' Updating live.' : null}
      </p>
      {!list.length ? (
        <p className="muted">{!loaded ? 'Loading…' : state?.state === 'running' || state?.state === 'pending' || !state ? 'Nothing yet: the agent has not started talking to its model.' : 'No transcript was recorded for this step (it ran before transcripts were kept, or on a worker that does not send them).'}</p>
      ) : (
        <div className="transcript">
          {list.map((e) => <Entry key={key(e)} e={e} />)}
          {state?.error && state.state !== 'running' ? <div className="tx tx-error"><div className="tx-head"><b>Step failed</b></div><div className="tx-text">{state.error.class}: {state.error.message}</div></div> : null}
          <div ref={end} />
        </div>
      )}
    </>
  );
}

const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

function Entry({ e }: { e: TranscriptEntry }) {
  switch (e.kind) {
    case 'system':
      return (
        <details className="tx tx-system">
          <summary><b>System prompt</b> <span className="muted small">{e.text?.length ?? 0} characters</span></summary>
          <div className="tx-text">{e.text}</div>
        </details>
      );
    case 'user':
      return <div className="tx tx-user"><div className="tx-head"><b>Prompt</b><span className="muted small">{time(e.at)}</span></div><Long text={e.text ?? ''} /></div>;
    case 'assistant':
      return <div className="tx tx-assistant"><div className="tx-head"><b>Model</b>{e.model ? <span className="muted small">{e.model}</span> : null}<span className="muted small">{time(e.at)}</span></div><div className="tx-text">{e.text}</div></div>;
    case 'reasoning':
      return (
        <details className="tx tx-reasoning">
          <summary><b>Reasoning</b> <span className="muted small">{time(e.at)}</span></summary>
          <div className="tx-text">{e.text}</div>
        </details>
      );
    case 'tool': {
      const tone = e.status === 'completed' ? 'ok' : e.status === 'error' ? 'bad' : 'run';
      return (
        <details className={`tx tx-tool ${tone}`} open={e.status === 'error'}>
          <summary>
            <b className="mono">{e.tool ?? 'tool'}</b> <Badge tone={`s ${tone}`}>{e.status === 'completed' ? 'done' : e.status ?? 'running'}</Badge>
            <span className="muted small"> {argLine(e.input)}</span>
            <span className="muted small tx-time">{time(e.at)}</span>
          </summary>
          <div className="tx-label">Input</div>
          <Json value={e.input ?? {}} />
          {e.status === 'error' ? <><div className="tx-label">Error</div><pre className="json bad">{e.error}</pre></> : e.output !== undefined ? <><div className="tx-label">Result</div><Json value={pretty(e.output)} /></> : <p className="muted small">Waiting for the result…</p>}
        </details>
      );
    }
    case 'step':
      return (
        <div className="tx tx-step muted small">
          Model call{e.model ? ` (${e.model})` : ''}: {num(e.tokens?.input ?? null)} in{e.tokens?.cache_read ? `, ${num(e.tokens.cache_read)} cached` : ''}, {num(e.tokens?.output ?? null)} out{e.tokens?.reasoning ? `, ${num(e.tokens.reasoning)} reasoning` : ''}{e.text && e.text !== 'tool-calls' && e.text !== 'success' ? ` · ${e.text}` : ''}
        </div>
      );
    case 'error':
      return <div className="tx tx-error"><div className="tx-head"><b>Error</b><span className="muted small">{time(e.at)}</span></div><div className="tx-text">{e.text}</div></div>;
    default:
      return <div className="tx tx-step muted small">{e.text}</div>;
  }
}

/** A long prompt shows its start, with the rest a click away. */
function Long({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= 1200 || all) return <div className="tx-text">{text}</div>;
  return <div className="tx-text">{text.slice(0, 1200)}… <button type="button" className="link small" onClick={() => setAll(true)}>Show all ({text.length} characters)</button></div>;
}

function argLine(input: unknown): string {
  if (input === undefined || input === null) return '';
  const t = typeof input === 'string' ? input : JSON.stringify(input);
  return t === '{}' ? '' : t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

/** Tool results are often JSON in a string; show them indented when they are. */
function pretty(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

export function AgentActivityPanel(props: Parameters<typeof AgentActivity>[0]) {
  return <Panel><AgentActivity {...props} /></Panel>;
}
