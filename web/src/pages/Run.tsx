import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, getToken, TERMINAL, type Approval, type RunPlan } from '../api';
import { useMe } from '../App';
import { atLeast } from '../api';
import { Link, useRoute } from '../router';
import { ago, Badge, ErrorNote, Json, Loading, money, num, PageHead, Panel, StateBadge, Table, useConfirm, when } from '../ui';
import { Formatted, Markdown, plainText } from '../components/Rich';
import { ApprovalCard } from './Approvals';
import { duration } from './Overview';
import { AgentActivityPanel, useTranscript, type TranscriptEntry } from './AgentActivity';
import { Feed, FeedEmpty, FeedItem, offsetOf, type FeedTone } from '../components/ActivityFeed';
import { Icon } from '../icons';
import { nodeStates, TYPE, WorkflowCanvas, type NodeRunState, type PlanNode } from '../components/WorkflowCanvas';

interface RunEvent { seq: number; at: string; kind: string; node_id: string | null; data: Record<string, any> }

export function RunPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const [ask, dialog] = useConfirm();
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
  // The evidence drawer over the canvas can be hidden, and stays hidden in this browser.
  const [drawerOpen, setDrawerOpen] = useState(() => {
    try {
      return localStorage.getItem(DRAWER_KEY) !== 'hidden';
    } catch {
      return true;
    }
  });
  const pickDrawer = (open: boolean) => {
    setDrawerOpen(open);
    try {
      localStorage.setItem(DRAWER_KEY, open ? 'shown' : 'hidden');
    } catch {
      /* not remembered */
    }
  };
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
      {dialog}
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
              {open && r.state !== 'cancelling' ? <button className="danger" disabled={cancel.isPending} onClick={async () => (await ask({ title: `Cancel run ${r.id}?`, text: 'Steps that have not started will not run.', confirm: 'Cancel run' })) && cancel.mutate()}>Cancel run</button> : null}
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
            title={r.workflow}
            tag={`v${r.workflow_version}`}
            nodes={version.data.plan.nodes}
            detail={d}
            plan={d.plan}
            height="clamp(400px, 66vh, 760px)"
            states={replayStates}
            stepActivity={(n, st) => <StepActivity key={n.id} node={n} run={st} detail={d} events={events} runId={id} open={open} />}
            head={drawerOpen ? null : (
              <button type="button" className="atlas-reopen" onClick={() => pickDrawer(true)} title="Show steps, ledger, policy, context and cost">
                <Icon name="runs" size={16} />Run details
              </button>
            )}
            aside={drawerOpen ? <Drawer className="atlas-drawer wf-side" nodes={version.data.plan.nodes} detail={d} show={show} onHide={() => pickDrawer(false)} /> : null}
            foot={<Replay events={events} cursor={cursor} playing={playing} onCursor={(c) => { setPlaying(false); setCursor(c); }} onPlay={() => { if (cursor === null) setCursor(0); setPlaying((x) => !x); }} />}
          />
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
          {tab === 'agent' ? <AgentActivityPanel onEvents={() => show('timeline')} runId={id} nodes={version.data?.plan?.nodes ?? []} detail={d} open={open} node={agentNode} onNode={setAgentNode} /> : tab === 'timeline' ? <Timeline events={events} /> : tab === 'inputs' ? <InputsTab detail={d} /> : tab === 'ledger' ? <Ledger detail={d} /> : tab === 'coverage' ? <Coverage plan={d.plan} /> : tab === 'context' ? <Context detail={d} /> : <UsageTab usage={d.usage} />}
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

type ActTab = 'input' | 'output' | 'events' | 'agent';
const ACT_INPUT_KEYS = ['input', 'arguments', 'query', 'for_each', 'payload', 'message', 'destination'];
const clock = (ms?: number | string) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const line = (t: string, n = 90) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The selected step in fullscreen: what went into it, what came out, its events, and its agent's messages. */
function StepActivity({ node, run, detail: d, events, runId, open }: { node: PlanNode; run?: NodeRunState; detail: any; events: RunEvent[]; runId: string; open: boolean }) {
  const isAgent = node.type === 'agent';
  const [tab, setTab] = useState<ActTab>(isAgent ? 'agent' : run?.error || run?.output !== undefined ? 'output' : 'input');
  const states = nodeStates(d);
  const mine = events.filter((e) => e.node_id === node.id);
  const tabs: Array<[ActTab, string, number?]> = [['input', 'Input'], ['output', 'Output'], ['events', 'Events', mine.length], ...(isAgent ? [['agent', 'Agent'] as [ActTab, string]] : [])];
  return (
    <section className="sa" aria-label={`Activity of ${node.id}`}>
      <div className="sa-tabs" role="tablist">
        {tabs.map(([k, label, n]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}{n ? <span className="sa-n">{n}</span> : null}</button>)}
      </div>
      <div className="sa-body" role="tabpanel">
        {tab === 'input' ? <StepInput node={node} states={states} inputs={d.run.inputs} /> : null}
        {tab === 'output' ? <StepOutput run={run} /> : null}
        {tab === 'events' ? <StepEvents events={mine} /> : null}
        {tab === 'agent' ? <StepAgent node={node.id} runId={runId} open={open} /> : null}
      </div>
    </section>
  );
}

const Fold = ({ title, hint, open, children }: { title: ReactNode; hint?: ReactNode; open?: boolean; children: ReactNode }) => (
  <details className="sa-fold" open={open}><summary><b>{title}</b>{hint ? <span className="muted small">{hint}</span> : null}</summary><div className="sa-fold-body">{children}</div></details>
);

/** What the step is given: its own mapping, then what each step it runs after returned. */
function StepInput({ node, states, inputs }: { node: PlanNode; states: Record<string, NodeRunState>; inputs: unknown }) {
  const def = node.def ?? {};
  const mapped = Object.fromEntries(ACT_INPUT_KEYS.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]));
  const from = node.deps.filter((id) => states[id]?.output !== undefined && states[id]?.output !== null);
  return (
    <>
      {Object.keys(mapped).length ? <Fold title="Mapped input" hint="from the workflow" open><Formatted value={mapped} plain /></Fold> : null}
      {!node.deps.length && inputs && Object.keys(inputs as object).length ? <Fold title="Run inputs" open><Formatted value={inputs} /></Fold> : null}
      {from.map((id, i) => <Fold key={id} title={id} hint="output" open={i === 0 && !Object.keys(mapped).length}><Formatted value={states[id]!.output} /></Fold>)}
      {!Object.keys(mapped).length && !from.length && !(!node.deps.length && inputs && Object.keys(inputs as object).length) ? <p className="muted small">Nothing was passed in from other steps.</p> : null}
    </>
  );
}

function StepOutput({ run }: { run?: NodeRunState }) {
  if (!run || run.state === 'pending') return <p className="muted small">This step has not started.</p>;
  if (run.error) return <Formatted value={run.error} plain />;
  if (run.output === undefined || run.output === null) return <p className="muted small">{run.state === 'running' ? 'Running. Its output appears here when it finishes.' : run.state === 'skipped' ? 'Skipped, so it returned nothing.' : 'No output.'}</p>;
  return <Formatted value={run.output} />;
}

function StepEvents({ events }: { events: RunEvent[] }) {
  if (!events.length) return <p className="muted small">No events for this step yet.</p>;
  return (
    <ol className="sa-events">
      {events.map((e) => {
        const dsc = describe(e);
        const more = summarise(e);
        return (
          <li key={e.seq} className={dsc.tone}>
            <span className="mono muted">{clock(e.at)}</span>
            <span>{dsc.text}{more && ['node.running', 'node.succeeded', 'node.skipped'].includes(e.kind) === false ? <details><summary className="muted small">Details</summary><pre className="code">{e.kind} #{e.seq}{'\n'}{more}</pre></details> : null}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** An agent step's conversation, compact: messages in full, tool calls and reasoning one line each. */
function StepAgent({ node, runId, open }: { node: string; runId: string; open: boolean }) {
  const { entries, enabled, loaded } = useTranscript(runId, open);
  const list = entries.filter((e) => e.node_id === node && e.kind !== 'system' && e.kind !== 'step' && e.kind !== 'note');
  const attempt = Math.max(0, ...list.map((e) => e.attempt));
  const shown = list.filter((e) => e.attempt === attempt);
  if (!enabled) return <p className="muted small">Agent transcripts are turned off on this server.</p>;
  if (!shown.length) return <p className="muted small">{loaded ? 'No agent messages yet.' : 'Loading…'}</p>;
  return (
    <div className="sa-chat">
      {attempt > 1 ? <p className="muted small">Attempt {attempt}</p> : null}
      {shown.map((e) => <ChatLine key={`${e.attempt}/${e.id}`} e={e} />)}
    </div>
  );
}

function ChatLine({ e }: { e: TranscriptEntry }) {
  const when = clock(e.at);
  if (e.kind === 'tool') {
    const tone = e.status === 'completed' ? 'ok' : e.status === 'error' ? 'bad' : 'run';
    return (
      <details className={`sa-tool ${tone}`}>
        <summary><i aria-hidden="true" /><b className="mono">{e.tool ?? 'tool'}</b><span className="muted">{line(typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? ''), 60)}</span></summary>
        <div className="sa-tool-io">
          <div className="sa-label">Input</div><Formatted value={e.input ?? {}} plain />
          {e.status === 'error' ? <><div className="sa-label">Error</div><pre className="json bad">{e.error}</pre></> : e.output !== undefined ? <><div className="sa-label">Result</div><Formatted value={e.output} plain /></> : <p className="muted small">Running…</p>}
        </div>
      </details>
    );
  }
  if (e.kind === 'reasoning') return <details className="sa-tool think"><summary><i aria-hidden="true" /><b>Reasoning</b><span className="muted">{line(e.text ?? '', 70)}</span></summary><div className="sa-tool-io"><Markdown text={e.text ?? ''} /></div></details>;
  const who = e.kind === 'user' ? 'Prompt' : e.kind === 'assistant' ? 'Assistant' : 'Error';
  const long = (e.text ?? '').length > 600;
  return (
    <div className={`sa-msg ${e.kind}`}>
      <div className="sa-msg-head"><b>{who}</b><span className="muted small">{when}</span></div>
      {long ? <details><summary className="muted small">{line(e.text ?? '', 120)}</summary><Markdown text={e.text ?? ''} /></details> : <Markdown text={e.text ?? ''} />}
    </div>
  );
}

const DRAWER_KEY = 'azhi.run.drawer';
const DRAWER: Record<string, string> = { steps: 'Steps', ledger: 'Ledger', coverage: 'Policy', context: 'Context', usage: 'Cost' };

/** The run's trust features in a panel over the canvas; each tab opens its full detail below. */
function Drawer({ nodes, detail: d, show, className, onHide }: { nodes: PlanNode[]; detail: any; show: (tab: string, node?: string) => void; className: string; onHide?: () => void }) {
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
      <div className="atlas-head">
        <div className="atlas-tabs" role="tablist">
          {Object.entries(DRAWER).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}{count[k] ? <span> {count[k]}</span> : null}</button>
          ))}
        </div>
        {onHide ? <button type="button" className="atlas-hide" onClick={onHide} aria-label="Hide run details" title="Hide run details"><Icon name="close" size={16} /></button> : null}
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

/** An event in plain words, with the icon and tone that carry its meaning besides colour. */
function describe(ev: RunEvent): { icon: string; tone: FeedTone; text: string; group: 'steps' | 'approvals' | 'problems' | 'run' } {
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

type EventFilter = 'all' | 'steps' | 'approvals' | 'problems';
function Timeline({ events }: { events: RunEvent[] }) {
  const [filter, setFilter] = useState<EventFilter>('all');
  const [q, setQ] = useState('');
  const [newestFirst, setNewestFirst] = useState(false);
  if (!events.length) return <FeedEmpty title="Waiting for the first event" text="Events appear here as the run progresses: steps starting and finishing, approvals, and problems." />;
  const start = new Date(events[0]!.at).getTime();
  const rows = events.map((e) => ({ e, d: describe(e) }));
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(({ e, d }) => (filter === 'all' || d.group === filter || (filter === 'steps' && d.group === 'run')) && (!needle || `${d.text} ${e.node_id ?? ''} ${e.kind}`.toLowerCase().includes(needle)));
  const list = newestFirst ? [...shown].reverse() : shown;
  const count = (f: EventFilter) => (f === 'all' ? rows.length : rows.filter(({ d }) => d.group === f).length);
  return (
    <div className="aa">
      <div className="aa-tools">
        <div className="seg" role="group" aria-label="Show">
          {([['all', 'All'], ['steps', 'Steps'], ['approvals', 'Approvals'], ['problems', 'Problems']] as Array<[EventFilter, string]>).map(([f, label]) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}{f !== 'all' ? <span className="aa-n"> {count(f)}</span> : null}</button>)}
        </div>
        <label className="aa-q"><Icon name="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events" aria-label="Search events" autoComplete="off" /></label>
        <div className="seg" role="group" aria-label="Order">
          <button type="button" aria-pressed={!newestFirst} onClick={() => setNewestFirst(false)}>Oldest first</button>
          <button type="button" aria-pressed={newestFirst} onClick={() => setNewestFirst(true)}>Newest first</button>
        </div>
      </div>
      {!list.length ? <FeedEmpty title="No events match" text="Try a broader search, or show every event." action="Clear filters" onAction={() => { setFilter('all'); setQ(''); }} /> : (
        <Feed label="Run events">
          {list.map(({ e, d }) => (
            <FeedItem key={e.seq} icon={d.icon} tone={d.tone} offset={offsetOf(new Date(e.at).getTime(), start)} offsetTitle={new Date(e.at).toLocaleTimeString()}>
              <div className="af-line">
                <span className="af-line-text">{d.text}</span>
                <span className="muted small">{new Date(e.at).toLocaleTimeString()}</span>
              </div>
              {summarise(e) ? <details className="af-quiet af-raw"><summary><span className="muted small">Details</span></summary><pre className="code">{e.kind} #{e.seq}{'\n'}{summarise(e)}</pre></details> : null}
            </FeedItem>
          ))}
        </Feed>
      )}
    </div>
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
    <section className="us-note" aria-label="GitHub Copilot usage">
      <div className="us-note-head">
        <b>GitHub Copilot</b>
        <span>{num(c.credits)} AI credits · worth {c.currency} {c.cost.toFixed(4)} at {c.currency} {c.credit_usd} each</span>
      </div>
      {c.models.length ? <div className="us-chips">{c.models.map((m: any) => <span key={m.model} className="us-chip mono">{m.model}<b>{num(m.credits)}</b></span>)}</div> : null}
      {c.unpriced_models.length ? <p className="warn-note">No Copilot rate is set for {c.unpriced_models.join(', ')}, so those steps have no cost. Add it before starting Azhi, for example <code>AZHI_COPILOT_RATES="{c.unpriced_models[0]}=INPUT/CACHED/OUTPUT"</code> in USD per million tokens from GitHub's Models and pricing page, then start a new run.</p> : null}
      <p>
        {pool
          ? pool.past_pool > 0
            ? `Monthly pool ${num(pool.monthly)} credits: Azhi had used ${num(pool.used_before)} this month before this run, so ${num(pool.past_pool)} credits (${c.currency} ${pool.past_pool_cost.toFixed(4)}) fell past the pool and are charged as additional usage, or blocked if your organization does not allow it.`
            : `Monthly pool ${num(pool.monthly)} credits: Azhi had used ${num(pool.used_before)} this month before this run and ${num(pool.left_after)} are left, so this run is covered by the pool (no extra charge).`
          : <>Set <code>AZHI_COPILOT_CREDIT_POOL</code> to your monthly credit pool to see what is left and what is charged as additional usage.</>}
      </p>
      <CopilotQuota />
      <p className="muted small">Estimated from the tokens OpenCode reports. Azhi counts only its own runs, not IDE or chat use drawing on the same pool.</p>
    </section>
  );
}

/** The signed-in user's own Copilot allowance now (what VS Code shows), from GitHub. */
function CopilotQuota() {
  const { data: q } = useQuery({ queryKey: ['copilot-quota'], queryFn: () => api<any>('/v1/copilot/quota'), retry: false, staleTime: 60_000 });
  const metered = (q?.quotas ?? []).filter((x: any) => !x.unlimited);
  if (!q?.ok || !metered.length) return null;
  return (
    <div className="us-quota">
      <span className="us-kicker">Your Copilot allowance now (from GitHub){q.reset_date ? ` · resets ${String(q.reset_date).slice(0, 10)}` : ''}</span>
      {metered.map((x: any) => {
        const pct = x.entitlement ? Math.min(100, Math.round((100 * x.used) / x.entitlement)) : 0;
        return (
          <div key={x.name} className="us-meter">
            <span>{x.name.replace(/_/g, ' ')}</span>
            <span className="us-track" role="img" aria-label={`${pct}% used`}><i style={{ width: `${pct}%` }} /></span>
            <span className="us-num">{num(x.used)} / {num(x.entitlement)}{x.percent_remaining !== null ? ` · ${Math.round(x.percent_remaining)}% left` : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Share of a turn's input that came from the prompt cache (cache read / input + cache read + cache write); input counts uncached tokens. */
function cacheShare(x: any): string {
  const total = (x.input_tokens ?? 0) + (x.cache_read_tokens ?? 0) + (x.cache_write_tokens ?? 0);
  return x.cache_read_tokens === null || x.cache_read_tokens === undefined || !total ? '—' : `${Math.round((100 * x.cache_read_tokens) / total)}%`;
}

function UsageTab({ usage: u }: { usage: any }) {
  if (!u.turns) return <p className="muted">No model usage in this run.</p>;
  const rows = u.records as any[];
  const total = (x: any) => (x.input_tokens ?? 0) + (x.cache_read_tokens ?? 0) + (x.output_tokens ?? 0);
  const widest = Math.max(1, ...rows.map(total));
  const w = (n: number | null | undefined) => `${Math.max(n ? 1.5 : 0, ((n ?? 0) / widest) * 100)}%`;
  const cached = rows.reduce((t, x) => t + (x.cache_read_tokens ?? 0), 0);
  const cur = u.cost.currency;
  return (
    <div className="us">
      <div className="us-tiles">
        <div className="us-tile main">
          <span className="us-kicker">Estimated cost</span>
          <b>{u.cost.amount === null ? 'Unavailable' : `${cur} ${u.cost.amount.toFixed(4)}`}</b>
          <span className="muted small">
            {u.cost.amount === null ? 'A turn has no declared pricing or no token counts.' : u.copilot ? `${num(u.copilot.credits)} credits at ${cur} ${u.copilot.credit_usd} each` : `pricing ${u.cost.pricing_revision}`}
          </span>
        </div>
        <div className="us-tile"><span className="us-kicker">Model calls</span><b>{num(u.turns)}</b><span className="muted small">usage known for {u.completeness_pct}%</span></div>
        <div className="us-tile"><span className="us-kicker">Tokens in / out</span><b>{num(u.input_tokens)} <span className="muted">/</span> {num(u.output_tokens)}</b><span className="muted small">{num(cached)} read from cache</span></div>
        {u.credits !== null && u.credits !== undefined ? <div className="us-tile"><span className="us-kicker">Copilot credits</span><b>{num(u.credits)}</b><span className="muted small">AI credits used</span></div> : null}
      </div>
      {u.copilot ? <CopilotUsage c={u.copilot} /> : null}
      <div className="us-legend" aria-hidden="true"><span><i className="in" />New input</span><span><i className="cache" />From cache</span><span><i className="out" />Output</span></div>
      <div className="table-wrap">
        <table className="us-table">
          <thead><tr><th>Step</th><th>Model</th><th>Tokens</th><th className="r">Cache</th><th className="r">Cost</th></tr></thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={i}>
                <td><b className="mono">{x.node_id}</b><span className="muted small"> turn {x.attempt}.{x.turn}</span></td>
                <td><span className="mono">{x.model ?? '—'}</span><br /><span className="muted small">{x.executor}</span></td>
                <td>
                  <span className="us-bar" role="img" aria-label={`${num(x.input_tokens)} new input, ${num(x.cache_read_tokens)} cached, ${num(x.output_tokens)} output`}>
                    <i className="in" style={{ width: w(x.input_tokens) }} /><i className="cache" style={{ width: w(x.cache_read_tokens) }} /><i className="out" style={{ width: w(x.output_tokens) }} />
                  </span>
                  <span className="muted small us-num">{num(x.input_tokens)} in · {num(x.cache_read_tokens)} cached · {num(x.output_tokens)} out{x.reasoning_tokens ? ` · ${num(x.reasoning_tokens)} reasoning` : ''}</span>
                </td>
                <td className="r us-num">{cacheShare(x)}</td>
                <td className="r us-num">
                  {x.cost_label === 'unavailable' ? 'unavailable' : <b>{x.cost?.toFixed?.(4) ?? x.cost}</b>}
                  {x.cost_label !== 'unavailable' ? <><br /><span className="muted small">{x.cost_label}{x.credits !== null && x.credits !== undefined ? ` · ${num(x.credits)} credits` : ''}</span></> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
