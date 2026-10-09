import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, getToken, TERMINAL, type Approval, type RunPlan } from '../api';
import { useMe } from '../App';
import { atLeast } from '../api';
import { Link, useRoute } from '../router';
import { ago, Badge, ErrorNote, Json, Loading, money, num, PageHead, Panel, StateBadge, Table, when } from '../ui';
import { Formatted, plainText } from '../components/Rich';
import { ApprovalCard, approvalQuestion, needsForm, useDecide, whoCanDecide } from './Approvals';
import { duration } from './Overview';
import { AgentActivityPanel } from './AgentActivity';
import { nodeStates, TYPE, WorkflowCanvas, type NodeRunState, type PlanNode } from '../components/WorkflowCanvas';

interface RunEvent { seq: number; at: string; kind: string; node_id: string | null; data: Record<string, any> }

export function RunPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const { navigate } = useRoute();
  const detail = useQuery({ queryKey: ['run', id], queryFn: () => api<any>(`/v1/runs/${encodeURIComponent(id)}`) });
  const versionId = detail.data?.run.workflow_version_id;
  const version = useQuery({ queryKey: ['version', versionId], queryFn: () => api<any>(`/v1/versions/${encodeURIComponent(versionId)}`), enabled: Boolean(versionId), staleTime: Infinity });
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: () => api<Approval[]>('/v1/approvals'), refetchInterval: 5_000 });
  const { events, live } = useRunEvents(id, () => void qc.invalidateQueries({ queryKey: ['run', id] }));
  const [tab, setTab] = useState('timeline');
  const [agentNode, setAgentNode] = useState<string | null>(null);
  // A run with agent steps opens on what its agents are doing.
  const hasAgents = Boolean(version.data?.plan?.nodes?.some((n: PlanNode) => n.type === 'agent'));
  const picked = useRef(false);
  useEffect(() => {
    if (hasAgents && !picked.current) setTab('agent');
  }, [hasAgents]);
  // Replay: the index of the event the canvas shows the run at, or null to follow the run live.
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? -1) + 1;
        if (next >= events.length - 1) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 450);
    return () => clearInterval(t);
  }, [playing, events.length]);
  const replayStates = useMemo(() => (cursor === null ? undefined : statesAt(events, cursor)), [events, cursor]);

  const cancel = useMutation({ mutationFn: () => api(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['run', id] }) });
  const rerun = useMutation({
    mutationFn: () => api<{ run_id: string }>('/v1/runs', { method: 'POST', body: { version: detail.data.run.workflow_version_id, inputs: detail.data.run.inputs ?? {}, ...(detail.data.run.test ? { test: true } : {}), ...(detail.data.run.snapshot?.model_defaults_chosen ? { model_defaults: detail.data.run.snapshot.model_defaults } : {}) } }),
    onSuccess: (r) => navigate(`/ui/runs/${encodeURIComponent(r.run_id)}`),
  });

  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data) return <Loading />;
  const d = detail.data;
  const r = d.run;
  const open = !TERMINAL.includes(r.state);
  const flags = Object.entries(r.flags ?? {}).filter(([, v]) => v) as Array<[string, any]>;
  const operator = atLeast(me.data?.role, 'operator');
  const waiting = (approvals.data ?? []).filter((a) => a.run_id === id);
  const show = (k: string, node?: string) => {
    picked.current = true;
    setTab(k);
    if (node) setAgentNode(node);
    requestAnimationFrame(() => document.getElementById('run-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  return (
    <>
      <div className="crumbs">
        <Link to="/ui/runs">Runs</Link> › <Link to={`/ui/workflows/${encodeURIComponent(r.workflow)}`}>{r.workflow}</Link> › <span className="mono">{r.id}</span>
        <span className="live">· {live}</span>
      </div>
      <PageHead
        title={<>{r.workflow} <span className="muted" style={{ fontWeight: 400 }}>v{r.workflow_version}</span></>}
        sub={<><StateBadge state={r.state} />{r.test ? <> <Badge tone="idle">test run</Badge></> : null} {runSentence(r)}</>}
        actions={
          operator ? (
            <>
              {open && r.state !== 'cancelling' ? <button className="danger" disabled={cancel.isPending} onClick={() => confirm('Cancel this run? Steps that have not started will not run.') && cancel.mutate()}>Cancel run</button> : null}
              {!open && !d.run.snapshot?.test_node ? <button disabled={rerun.isPending} onClick={() => rerun.mutate()} title="Start a new run of the same version with the same inputs">Run again</button> : null}
            </>
          ) : null
        }
      />
      <ErrorNote error={cancel.error ?? rerun.error} />
      {flags.filter(([k]) => k !== 'waiting_reason').length ? <div className="flags">{flags.filter(([k]) => k !== 'waiting_reason').map(([k]) => <Badge key={k} tone="s warn">{k.replaceAll('_', ' ')}</Badge>)}</div> : null}
      {r.error ? <div className="error"><strong>{r.error.class}</strong>: {r.error.message}</div> : null}
      {version.data?.plan?.nodes ? (
        <div className="atlas">
          <WorkflowCanvas
            nodes={version.data.plan.nodes}
            detail={d}
            plan={d.plan}
            height="clamp(400px, 66vh, 760px)"
            controls="top-left"
            inset={{ right: 334, bottom: 64 }}
            states={replayStates}
            toolbar={waiting[0] && cursor === null ? { node: waiting[0].node_id, content: <DecisionPop a={waiting[0]} /> } : undefined}
          >
            <Drawer className="atlas-drawer floating" nodes={version.data.plan.nodes} detail={d} show={show} />
            <Replay events={events} cursor={cursor} playing={playing} onCursor={(c) => { setPlaying(false); setCursor(c); }} onPlay={() => { if (cursor === null) setCursor(0); setPlaying((x) => !x); }} />
          </WorkflowCanvas>
          <Drawer className="atlas-drawer stacked" nodes={version.data.plan.nodes} detail={d} show={show} />
        </div>
      ) : <Loading />}
      {waiting.length ? (
        <section id="decision" className="atlas-decisions" aria-label="Decision details">
          {waiting.map((a) => <ApprovalCard key={a.node_id} approval={a} compact />)}
        </section>
      ) : null}
      <div id="run-detail" style={{ scrollMarginTop: 112 }}>
        <div className="tabs" role="tablist">
          {Object.entries(TABS).filter(([k]) => k !== 'agent' || hasAgents).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => { picked.current = true; setTab(k); }}>{label}</button>)}
        </div>
        <div className="tab" role="tabpanel">
          {tab === 'agent' ? <AgentActivityPanel runId={id} nodes={version.data?.plan?.nodes ?? []} detail={d} open={open} node={agentNode} onNode={setAgentNode} /> : tab === 'timeline' ? <Timeline events={events} /> : tab === 'inputs' ? <InputsTab detail={d} /> : tab === 'ledger' ? <Ledger detail={d} /> : tab === 'coverage' ? <Coverage plan={d.plan} /> : tab === 'context' ? <Context detail={d} /> : <UsageTab usage={d.usage} />}
        </div>
      </div>
    </>
  );
}

function runSentence(r: any): string {
  const by = r.trigger === 'schedule' ? 'by its schedule' : r.trigger === 'test' ? 'as a test' : `from ${r.trigger}`;
  const why = r.flags?.waiting_reason;
  switch (r.state) {
    case 'waiting':
      return why?.reason === 'approval' ? `Waiting for a person to decide at step ${why.node}. Started ${ago(r.created_at)} ${by}.` : `Waiting for ${String(why?.reason ?? 'something').replaceAll('_', ' ')}${why?.node ? ` on ${why.node}` : ''}. Started ${ago(r.created_at)} ${by}.`;
    case 'queued':
      return `Queued ${ago(r.created_at)} ${by}.`;
    case 'running':
      return `Running for ${duration(r.created_at, new Date().toISOString())}. Started ${by}.`;
    case 'succeeded':
      return `Finished in ${duration(r.created_at, r.ended_at)}. Started ${ago(r.created_at)} ${by}.`;
    case 'cancelling':
      return 'Cancelling: steps already running are being stopped.';
    case 'cancelled':
      return `Cancelled after ${duration(r.created_at, r.ended_at ?? r.created_at)}.`;
    default:
      return `Stopped (${r.state.replaceAll('_', ' ')}) after ${duration(r.created_at, r.ended_at ?? r.created_at)}.`;
  }
}

const STEP_ICON: Record<string, [string, string, string]> = {
  succeeded: ['ok', '✓', 'Done'], failed: ['bad', '✕', 'Failed'], waiting: ['warn', '■', 'Waiting'], running: ['run', '●', 'Running'],
  skipped: ['', '–', 'Skipped'], pending: ['', '○', 'Not started'], cancelled: ['', '–', 'Cancelled'],
};

const short = (v: unknown, n = 140) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** A step's output in a few words: short text as is, otherwise its size or its field names. */
function outputSummary(v: unknown): string {
  if (typeof v === 'string') return short(plainText(v));
  if (typeof v === 'number' || typeof v === 'boolean') return `Returned ${String(v)}`;
  if (Array.isArray(v)) return `Returned ${v.length} item${v.length === 1 ? '' : 's'}`;
  const o = v as Record<string, unknown>;
  const inner = o.output;
  if (Array.isArray(inner)) return `Returned ${inner.length} item${inner.length === 1 ? '' : 's'}`;
  if (inner !== undefined && inner !== null && typeof inner !== 'object') return `Returned ${short(String(inner), 100)}`;
  const keys = Object.keys(o);
  return keys.length ? `Returned ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ` and ${keys.length - 4} more` : ''}` : 'Done';
}

/** Each step in plan order, with what it did, when, and what its model calls cost. */
function Steps({ nodes, detail: d, onAgent }: { nodes: PlanNode[]; detail: any; onAgent?: (node: string) => void }) {
  const states = nodeStates(d);
  return (
    <div className="receipt">
      {nodes.map((n) => {
        const st = states[n.id];
        const state = st?.state ?? 'pending';
        const [tone, glyph, word] = STEP_ICON[state] ?? ['', '○', state];
        const attempts = (d.attempts as any[]).filter((a) => a.node_id === n.id);
        const last = attempts[attempts.length - 1];
        const at = last?.ended_at ?? last?.started_at;
        const cost = (d.usage?.records ?? []).filter((x: any) => x.node_id === n.id && typeof x.cost === 'number').reduce((t: number, x: any) => t + x.cost, 0);
        const approval = (d.approvals as any[]).find((a) => a.node_id === n.id && a.decision);
        const err = st?.error as any;
        const what = err
          ? short(err.message ?? err)
          : approval
            ? `${approval.decision === 'approved' ? 'Approved' : 'Rejected'} by ${approval.decided_by}${approval.decided_at ? ` ${ago(approval.decided_at)}` : ''}`
            : st?.route
              ? `Chose ${st.route}`
              : state === 'succeeded' && st?.output !== undefined && st?.output !== null
                ? outputSummary(st.output)
                : state === 'waiting' && n.type === 'approval'
                  ? 'Waiting for a person'
                  : word;
        return (
          <div className="step" key={n.id}>
            <span className={`ic ${tone}`} aria-hidden="true">{glyph}</span>
            <div style={{ minWidth: 0 }}>
              <div className="name">{n.id} <span className="muted small">{TYPE[n.type]?.label ?? n.type}{st && st.attempts > 1 ? ` · ${st.attempts} attempts` : ''}</span></div>
              <div className={`what ${err ? 'bad' : ''}`}><span className="visually-hidden">{word}: </span>{what}</div>
              {n.type === 'agent' && onAgent && state !== 'pending' && state !== 'skipped' ? <button type="button" className="link small" onClick={() => onAgent(n.id)}>{state === 'running' ? 'Watch the agent live' : 'See what the agent did'}</button> : null}
            </div>
            <span className="when">{at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}{cost ? <><br />{money(cost)}</> : null}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The decision pinned under a waiting approval step: the question, a few facts and the buttons. */
function DecisionPop({ a }: { a: Approval }) {
  const decide = useDecide(a);
  const payload = a.request.payload;
  const facts = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.entries(payload as Record<string, unknown>).slice(0, 3).map(([k, v]) => `${k.replace(/[_-]+/g, ' ')}: ${Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : v !== null && typeof v === 'object' ? 'details' : String(v)}`)
    : [];
  const details = () => document.getElementById('decision')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="atlas-pop" role="group" aria-label={`Decision on ${a.node_id}`}>
      <b>{plainText(approvalQuestion(a))}</b>
      {facts.length ? <span className="muted small">{facts.join(' · ')}</span> : null}
      <span className="muted small">{whoCanDecide(a.role)} can decide{a.expires_at ? ` · expires ${ago(a.expires_at)}` : ''}</span>
      {decide.isSuccess ? (
        <span className="ok-note" role="status">Decision recorded.</span>
      ) : (
        <div className="row">
          {a.can_decide && !needsForm(a) ? (
            <>
              <button className="primary" disabled={decide.isPending} onClick={() => decide.mutate({ decision: 'approved' })}>Approve</button>
              <button className="danger" disabled={decide.isPending} onClick={() => decide.mutate({ decision: 'rejected' })}>Reject</button>
            </>
          ) : a.can_decide ? (
            <button className="primary" onClick={details}>Decide</button>
          ) : null}
          <button className="link" style={{ marginLeft: 'auto' }} onClick={details}>Details</button>
        </div>
      )}
      <ErrorNote error={decide.error} />
    </div>
  );
}

const DRAWER: Record<string, string> = { steps: 'Steps', ledger: 'Ledger', coverage: 'Policy', context: 'Context', usage: 'Cost' };

/** The run's trust features in a panel over the canvas; each tab opens its full detail below. */
function Drawer({ nodes, detail: d, show, className }: { nodes: PlanNode[]; detail: any; show: (tab: string, node?: string) => void; className: string }) {
  const [tab, setTab] = useState('steps');
  const p: RunPlan | null = d.plan;
  const controls = p ? p.nodes.flatMap((n) => n.coverage ?? []) : [];
  const enforced = controls.filter((c) => c.enforcement === 'enforced').length;
  const gaps = p ? p.nodes.flatMap((n) => n.requirements ?? []).filter((q) => q.mark === 'unsupported').length : 0;
  const items = (d.context_manifests as any[]).reduce((t, m) => t + (m.items?.length ?? 0), 0);
  const tainted = (d.context_manifests as any[]).filter((m) => m.tainted).length;
  const u = d.usage;
  const count: Record<string, string> = {
    ledger: String(d.actions.length),
    coverage: controls.length ? `${enforced}/${controls.length}` : '',
    context: String(items),
  };
  const more = (k: string, label: string) => <button type="button" className="link small" onClick={() => show(k)}>{label}</button>;
  return (
    <aside className={className} aria-label="Run evidence">
      <div className="atlas-tabs" role="tablist">
        {Object.entries(DRAWER).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}{count[k] ? <span> {count[k]}</span> : null}</button>
        ))}
      </div>
      <div className="atlas-panel" role="tabpanel">
        {tab === 'steps' ? (
          <><Steps nodes={nodes} detail={d} onAgent={(n) => show('agent', n)} />{more('inputs', 'Inputs and outputs')}</>
        ) : tab === 'ledger' ? (
          <>
            {d.actions.length ? (
              <div className="kv-list">
                {(d.actions as any[]).map((a) => <div key={a.id}><span>{a.tool} <span className="muted">· {a.node_id}</span></span><Badge tone={`s ${a.state === 'confirmed' ? 'ok' : a.state === 'failed' ? 'bad' : a.state === 'outcome_unknown' ? 'warn' : 'run'}`}>{a.state.replaceAll('_', ' ')}</Badge></div>)}
              </div>
            ) : <p className="muted">No external writes.</p>}
            {more('ledger', 'Full action ledger')}
          </>
        ) : tab === 'coverage' ? (
          <>
            {p ? <Badge tone={`s ${p.ok ? 'ok' : 'bad'}`}>{p.ok ? 'Run plan has no blockers' : `${p.blockers.length} blocker${p.blockers.length === 1 ? '' : 's'}`}</Badge> : <p className="muted">No run plan was recorded.</p>}
            {p ? <p>{p.signer?.verified ? `Signed by ${p.signer.publisher}.` : 'Signature not verified.'} {controls.length ? `${enforced} of ${controls.length} controls are enforced by Azhi itself.` : 'No step makes a controlled action.'}{gaps ? ` ${gaps} requirement${gaps === 1 ? ' is' : 's are'} not supported.` : ''}</p> : null}
            {more('coverage', 'Full policy coverage')}
          </>
        ) : tab === 'context' ? (
          <>
            <p>{items} source{items === 1 ? '' : 's'} {d.context_manifests.length ? `across ${d.context_manifests.length} model call${d.context_manifests.length === 1 ? '' : 's'}.` : '(no model calls).'}{tainted ? ` ${tainted} saw untrusted content.` : ''}</p>
            {more('context', 'Full context manifest')}
          </>
        ) : (
          <>
            <span className="big">{u.turns ? (u.cost.amount === null ? 'Unknown' : money(u.cost.amount, u.cost.currency)) : money(0)}</span>
            <p>{u.turns ? `${num(u.turns)} model call${u.turns === 1 ? '' : 's'}, usage known for ${u.completeness_pct}%.` : 'No model calls.'}</p>
            {more('usage', 'Full usage')}
          </>
        )}
      </div>
    </aside>
  );
}

/** Node states as they stood after event `upto`, rebuilt from the event log. */
function statesAt(events: RunEvent[], upto: number): Record<string, NodeRunState> {
  const s: Record<string, NodeRunState> = {};
  for (const ev of events.slice(0, upto + 1)) {
    if (!ev.node_id) continue;
    const prev = s[ev.node_id] ?? { state: 'pending', attempts: 0 };
    if (ev.kind === 'node.running') s[ev.node_id] = { ...prev, state: 'running', attempts: prev.attempts + 1 };
    else if (ev.kind.startsWith('node.') && ['succeeded', 'failed', 'skipped', 'cancelled'].includes(ev.kind.slice(5))) {
      s[ev.node_id] = { ...prev, state: ev.kind.slice(5), ...(ev.data?.route !== undefined ? { output: { route: ev.data.route } } : {}), ...(ev.data?.error ? { error: ev.data.error } : {}) };
    } else if (ev.kind === 'approval.requested') s[ev.node_id] = { ...prev, state: 'waiting' };
  }
  return s;
}

/** A scrubber over the run's events: drag or play to watch how the run got to where it is. */
function Replay({ events, cursor, playing, onCursor, onPlay }: { events: RunEvent[]; cursor: number | null; playing: boolean; onCursor: (c: number | null) => void; onPlay: () => void }) {
  if (events.length < 2) return null;
  const last = events.length - 1;
  const at = cursor ?? last;
  const ev = events[at]!;
  return (
    <div className="atlas-replay">
      <button type="button" onClick={onPlay} aria-label={playing ? 'Pause the replay' : 'Replay the run'}>{playing ? 'Pause' : 'Replay'}</button>
      <div className="atlas-track">
        <div className="atlas-ticks" aria-hidden="true">
          {events.map((e, i) => (
            <i key={e.seq} className={e.kind.startsWith('approval') ? 'warn' : e.kind.endsWith('failed') ? 'bad' : ''} style={{ left: `${(i / last) * 100}%` }} title={e.kind} />
          ))}
        </div>
        <input type="range" min={0} max={last} value={at} aria-label="Event to show the run at" aria-valuetext={`${ev.kind}${ev.node_id ? ` on ${ev.node_id}` : ''}, event ${at + 1} of ${events.length}`} onChange={(e) => onCursor(Number(e.target.value) >= last ? null : Number(e.target.value))} />
      </div>
      <span className="atlas-at">
        <span className="mono">{new Date(ev.at).toLocaleTimeString()}</span> {ev.kind}{ev.node_id ? ` · ${ev.node_id}` : ''}
        <span className="muted"> · {at + 1} of {events.length}</span>
      </span>
      {cursor !== null ? <button type="button" className="link small" onClick={() => onCursor(null)}>Back to live</button> : null}
    </div>
  );
}

const TABS: Record<string, string> = { agent: 'Agent activity', timeline: 'Event log', inputs: 'Inputs and outputs', ledger: 'Action ledger', coverage: 'Policy coverage', context: 'Context manifest', usage: 'Usage' };

/** Follows the SSE stream, resuming from the last event ID after a disconnect. */
function useRunEvents(id: string, onEvent: () => void) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [live, setLive] = useState('connecting');
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let stop = false;
    let cursor = 0;
    const ctl = new AbortController();
    setEvents([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 250);
    };
    (async () => {
      let backoff = 500;
      while (!stop) {
        try {
          const res = await fetch(`/v1/runs/${encodeURIComponent(id)}/events`, { signal: ctl.signal, headers: { authorization: `Bearer ${getToken()}`, accept: 'text/event-stream', 'last-event-id': String(cursor) } });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          backoff = 500;
          setLive('live');
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done || stop) break;
            buf += value;
            let i;
            const batch: RunEvent[] = [];
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
              if (!data) continue;
              const ev = JSON.parse(data) as RunEvent;
              if (ev.seq <= cursor) continue;
              cursor = ev.seq;
              batch.push(ev);
            }
            if (batch.length) {
              setEvents((e) => [...e, ...batch]);
              refresh();
            }
          }
        } catch {
          if (stop) return;
          setLive('reconnecting');
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 8000);
          continue;
        }
        // The server closes the stream once the run has ended and every event has been sent.
        const d = await api<any>(`/v1/runs/${encodeURIComponent(id)}`).catch(() => null);
        cb.current();
        if (d && TERMINAL.includes(d.run.state)) return setLive('finished');
        await new Promise((r) => setTimeout(r, backoff));
      }
    })();
    return () => {
      stop = true;
      ctl.abort();
      clearTimeout(timer);
    };
  }, [id]);
  return { events, live };
}

function summarise(ev: RunEvent) {
  const d = ev.data ?? {};
  if (ev.kind === 'run.planned') return `run plan recorded: ${d.ok ? 'no blockers' : `${d.blockers?.length} blocker(s)`}, ${d.nodes?.length ?? 0} nodes`;
  const s = JSON.stringify(d);
  return s === '{}' ? '' : s.length > 160 ? s.slice(0, 159) + '…' : s;
}

function Timeline({ events }: { events: RunEvent[] }) {
  if (!events.length) return <p className="muted">Waiting for events…</p>;
  return (
    <Panel>
      <Table head={['#', 'Time', 'Event', 'Node', 'Detail']}>
        {events.map((e) => (
          <tr key={e.seq}><td className="mono">{e.seq}</td><td className="nowrap">{new Date(e.at).toLocaleTimeString()}</td><td className="mono">{e.kind}</td><td>{e.node_id ?? ''}</td><td className="mono">{summarise(e)}</td></tr>
        ))}
      </Table>
    </Panel>
  );
}

function InputsTab({ detail: d }: { detail: any }) {
  return (
    <>
      <Panel title="Inputs"><Formatted value={d.run.inputs ?? {}} /></Panel>
      <Panel title="Node attempts">
        <Table head={['Node', 'Attempt', 'State', 'Worker', 'Output or error']} empty="No node has run yet.">
          {d.attempts.map((a: any) => (
            <tr key={`${a.node_id}/${a.attempt}`}>
              <td>{a.node_id}</td><td>{a.attempt}</td><td><StateBadge state={a.state} /></td><td className="mono">{a.worker_id ?? '—'}</td>
              <td>{a.error ? <Json value={a.error} /> : a.output !== null && a.output !== undefined ? <details><summary>output</summary><Formatted value={a.output} /></details> : '—'}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

function Ledger({ detail: d }: { detail: any }) {
  if (!d.actions.length) return <p className="muted">This run has made no external writes.</p>;
  return (
    <Panel>
      <Table head={['Action', 'Node', 'Tool', 'State', 'Transitions', 'Receipt']}>
        {d.actions.map((a: any) => (
          <tr key={a.id}>
            <td className="mono">{a.id}</td><td>{a.node_id}</td><td>{a.tool}<br /><span className="muted">{a.effect}</span></td>
            <td><Badge tone={a.state === 'confirmed' ? 'ok' : a.state === 'failed' ? 'bad' : a.state === 'outcome_unknown' ? 'warn' : 'run'}>{a.state}</Badge></td>
            <td>{a.transitions.map((t: any) => `${t.state} (fence ${t.fence})`).join(' → ')}</td>
            <td className="mono">{a.receipt ? JSON.stringify(a.receipt) : a.error ? JSON.stringify(a.error) : '—'}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

const MARK: Record<string, string> = { native: 'ok', bridged: 'warn', unverified: 'warn', unsupported: 'bad' };
const ENF: Record<string, string> = { enforced: 'ok', harness: 'warn', unobservable: 'bad' };

export function Coverage({ plan: p, live, note }: { plan: RunPlan | null; live?: boolean; note?: ReactNode }) {
  if (!p) return <p className="muted">This run was created before run plans were recorded with runs.</p>;
  const controls = p.nodes.flatMap((n) => (n.coverage ?? []).map((c, i) => (
    <tr key={`${n.id}-c${i}`}><td>{n.id}</td><td>{c.action}</td><td><Badge tone={ENF[c.enforcement]}>{c.enforcement}</Badge></td><td className="muted">{c.detail}</td></tr>
  )));
  const reqs = p.nodes.flatMap((n) => (n.requirements ?? []).map((q, i) => (
    <tr key={`${n.id}-r${i}`}><td>{n.id}</td><td>{q.name}</td><td><Badge tone={MARK[q.mark]}>{q.mark}</Badge></td><td className="muted">{q.detail}</td></tr>
  )));
  const tainted = p.nodes.filter((n) => n.tainted);
  return (
    <>
      <p>
        {p.signer?.verified ? `Signed by ${p.signer.publisher}, verified.` : `Signature not verified${p.signer?.error ? `: ${p.signer.error}` : ''}.`}{' '}
        {p.ok ? 'The plan has no blockers.' : `The plan has ${p.blockers.length} blocker(s).`}
      </p>
      {p.blockers?.length ? <div className="error">{p.blockers.map((b, i) => <div key={i}>{b.node ? `${b.node}: ` : ''}{b.message}</div>)}</div> : null}
      {tainted.length ? <p className="muted">Tainted nodes (they saw untrusted content, so their writes need a gate): {tainted.map((n) => `${n.id} (${n.tainted})`).join(', ')}</p> : null}
      <Panel title="Controls on each action"><Table head={['Node', 'Action', 'Enforcement', 'How']} empty="No controlled actions.">{controls}</Table></Panel>
      <Panel title="Requirements"><Table head={['Node', 'Requirement', 'Mark', 'Detail']} empty="No requirements.">{reqs}</Table></Panel>
      {note ? <p className="muted">{note}</p> : live ? <p className="muted">This is the plan as it stands now, for you, with the workers online now.</p> : <p className="muted">This is the plan as it stood when the run was created.</p>}
    </>
  );
}

function Context({ detail: d }: { detail: any }) {
  if (!d.context_manifests.length) return <p className="muted">No agent turns recorded a context manifest.</p>;
  return (
    <>
      {d.context_manifests.map((m: any) => (
        <details key={`${m.node_id}/${m.attempt}/${m.turn}`} className="panel" open={d.context_manifests.length < 4}>
          <summary>{m.node_id} · attempt {m.attempt} · turn {m.turn} · {num(m.total_tokens)} tokens ({m.token_source}) {m.tainted ? <Badge tone="bad">tainted</Badge> : null}</summary>
          <Table head={['Kind', 'Source', 'Reason', 'Tokens', 'Hash']}>
            {(m.items ?? []).map((i: any, k: number) => (
              <tr key={k}><td>{i.kind ?? ''}</td><td>{i.source}</td><td>{i.reason ?? ''}</td><td>{num(i.tokens ?? i.token_estimate)}</td><td className="mono">{String(i.content_hash ?? '').slice(0, 19)}</td></tr>
            ))}
          </Table>
        </details>
      ))}
    </>
  );
}

/** Copilot bills GitHub AI Credits (tokens at per-model rates) out of a monthly pool, so its cost is shown in credits. */
function CopilotUsage({ c }: { c: any }) {
  const pool = c.pool;
  return (
    <p>
      GitHub Copilot: {num(c.credits)} AI credits{c.models.length ? ` (${c.models.map((m: any) => `${m.model} ${num(m.credits)}`).join('; ')})` : ''}, worth {c.currency} {c.cost.toFixed(4)} at {c.currency} {c.credit_usd} per credit.{' '}
      {c.unpriced_models.length ? `No Copilot rate is set for ${c.unpriced_models.join(', ')}, so those steps have no cost. Add it before starting Azhi, for example AZHI_COPILOT_RATES="${c.unpriced_models[0]}=INPUT/CACHED/OUTPUT" in USD per million tokens from GitHub's Models and pricing page, then start a new run. ` : ''}
      {pool
        ? pool.past_pool > 0
          ? `Monthly pool ${num(pool.monthly)} credits: Azhi had used ${num(pool.used_before)} this month before this run, so ${num(pool.past_pool)} credits (${c.currency} ${pool.past_pool_cost.toFixed(4)}) fell past the pool and are charged as additional usage, or blocked if your organization does not allow it. `
          : `Monthly pool ${num(pool.monthly)} credits: Azhi had used ${num(pool.used_before)} this month before this run and ${num(pool.left_after)} are left, so this run is covered by the pool (no extra charge). `
        : 'Set AZHI_COPILOT_CREDIT_POOL to your monthly credit pool to see what is left and what is charged as additional usage. '}
      <span className="muted">Estimated from the tokens OpenCode reports. Azhi counts only its own runs, not IDE or chat use drawing on the same pool.</span>
      <CopilotQuotaLine />
    </p>
  );
}

/** The signed-in user's own Copilot allowance now (what VS Code shows), from GitHub. */
function CopilotQuotaLine() {
  const { data: q } = useQuery({ queryKey: ['copilot-quota'], queryFn: () => api<any>('/v1/copilot/quota'), retry: false, staleTime: 60_000 });
  const metered = (q?.quotas ?? []).filter((x: any) => !x.unlimited);
  if (!q?.ok || !metered.length) return null;
  return (
    <>
      <br />
      Your Copilot allowance now (from GitHub): {metered.map((x: any) => `${x.name.replace(/_/g, ' ')} ${num(x.used)} used of ${num(x.entitlement)}${x.percent_remaining !== null ? `, ${Math.round(x.percent_remaining)}% left` : ''}`).join('; ')}
      {q.reset_date ? `, resets ${String(q.reset_date).slice(0, 10)}` : ''}.
    </>
  );
}

/** Share of a turn's input that came from the prompt cache (cache read / input + cache read + cache write); input counts uncached tokens. */
function cacheShare(x: any): string {
  const total = (x.input_tokens ?? 0) + (x.cache_read_tokens ?? 0) + (x.cache_write_tokens ?? 0);
  return x.cache_read_tokens === null || x.cache_read_tokens === undefined || !total ? '—' : `${Math.round((100 * x.cache_read_tokens) / total)}%`;
}

function UsageTab({ usage: u }: { usage: any }) {
  if (!u.turns) return <p className="muted">No model usage in this run.</p>;
  return (
    <>
      <p>
        {u.turns} turn(s). Usage is known for {u.completeness_pct}% of them. Tokens: {num(u.input_tokens)} in, {num(u.output_tokens)} out.{u.credits !== null && u.credits !== undefined ? ` Copilot AI credits used: ${num(u.credits)}.` : ''}{' '}
        {u.cost.amount === null
          ? 'Cost is unavailable: at least one turn has no declared pricing or no token counts.'
          : u.copilot
            ? `Estimated cost ${u.cost.currency} ${u.cost.amount.toFixed(4)} (${num(u.copilot.credits)} credits at ${u.cost.currency} ${u.copilot.credit_usd} each).`
            : `Estimated cost ${u.cost.currency} ${u.cost.amount.toFixed(4)} (pricing ${u.cost.pricing_revision}).`}
      </p>
      {u.copilot ? <CopilotUsage c={u.copilot} /> : null}
      <Panel>
        <Table head={['Node', 'Turn', 'Executor', 'Model', 'In', 'Out', 'Cache read', 'Cache share', 'Reasoning', 'Cost']}>
          {u.records.map((x: any, i: number) => (
            <tr key={i}>
              <td>{x.node_id}</td><td>{x.attempt}.{x.turn}</td><td>{x.executor}</td><td>{x.model ?? '—'}</td><td>{num(x.input_tokens)}</td><td>{num(x.output_tokens)}</td><td>{num(x.cache_read_tokens)}</td><td>{cacheShare(x)}</td><td>{num(x.reasoning_tokens)}</td>
              <td>{x.cost_label === 'unavailable' ? 'unavailable' : `${x.cost?.toFixed?.(4) ?? x.cost} (${x.cost_label}${x.credits !== null && x.credits !== undefined ? `, ${num(x.credits)} credits` : ''})`}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
