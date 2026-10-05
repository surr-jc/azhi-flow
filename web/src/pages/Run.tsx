import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, getToken, TERMINAL, type Approval, type RunPlan } from '../api';
import { useMe } from '../App';
import { atLeast } from '../api';
import { Link, useRoute } from '../router';
import { Badge, ErrorNote, Json, Loading, num, PageHead, Panel, StateBadge, Table, when } from '../ui';
import { ApprovalCard } from './Approvals';
import { duration } from './Overview';
import { WorkflowCanvas } from '../components/WorkflowCanvas';

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

  const cancel = useMutation({ mutationFn: () => api(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['run', id] }) });
  const rerun = useMutation({
    mutationFn: () => api<{ run_id: string }>('/v1/runs', { method: 'POST', body: { version: detail.data.run.workflow_version_id, inputs: detail.data.run.inputs ?? {}, ...(detail.data.run.test ? { test: true } : {}) } }),
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
  return (
    <>
      <PageHead
        title={<><Link to={`/ui/workflows/${encodeURIComponent(r.workflow)}`}>{r.workflow}</Link>@{r.workflow_version}</>}
        sub={<><span className="mono">{r.id}</span> <StateBadge state={r.state} /> {r.test ? <Badge tone="idle">test run</Badge> : null} <span className="live">{live}</span></>}
        actions={
          operator ? (
            <>
              {open && r.state !== 'cancelling' ? <button className="danger" disabled={cancel.isPending} onClick={() => confirm('Cancel this run?') && cancel.mutate()}>Cancel run</button> : null}
              {!open && !d.run.snapshot?.test_node ? <button disabled={rerun.isPending} onClick={() => rerun.mutate()} title="Start a new run of the same version with the same inputs">Run again</button> : null}
            </>
          ) : null
        }
      />
      <ErrorNote error={cancel.error ?? rerun.error} />
      {flags.length ? <div className="flags">{flags.map(([k, v]) => <Badge key={k} tone="warn">{k === 'waiting_reason' ? `waiting for ${v.reason.replace('_', ' ')}${v.node ? ` on ${v.node}` : ''}` : k.replaceAll('_', ' ')}</Badge>)}</div> : null}
      <div className="meta">
        <div><span>Trigger</span>{r.trigger}</div>
        <div><span>Created</span>{when(r.created_at)}</div>
        <div><span>Ended</span>{when(r.ended_at)}{r.ended_at ? ` (${duration(r.created_at, r.ended_at)})` : ''}</div>
        <div><span>Usage</span>{usageLine(d.usage)}</div>
        <div><span>Package</span><span className="mono">{String(r.snapshot?.package_hash ?? '').slice(0, 19)}</span></div>
      </div>
      {r.error ? <div className="error"><strong>{r.error.class}</strong>: {r.error.message}</div> : null}
      {waiting.map((a) => <ApprovalCard key={a.node_id} approval={a} compact />)}
      <Panel title="Workflow">{version.data?.plan?.nodes ? <WorkflowCanvas nodes={version.data.plan.nodes} detail={d} plan={d.plan} /> : <p className="muted">Loading the workflow…</p>}</Panel>
      <div className="tabs" role="tablist">
        {Object.entries(TABS).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      <div className="tab" role="tabpanel">
        {tab === 'timeline' ? <Timeline events={events} /> : tab === 'inputs' ? <InputsTab detail={d} /> : tab === 'ledger' ? <Ledger detail={d} /> : tab === 'coverage' ? <Coverage plan={d.plan} /> : tab === 'context' ? <Context detail={d} /> : <UsageTab usage={d.usage} />}
      </div>
    </>
  );
}

const TABS: Record<string, string> = { timeline: 'Timeline', inputs: 'Inputs and outputs', ledger: 'Action ledger', coverage: 'Policy coverage', context: 'Context manifest', usage: 'Usage' };

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

function usageLine(u: any) {
  if (!u.turns) return 'no model turns';
  const cost = u.cost.amount === null ? 'cost unavailable' : `${u.cost.currency} ${u.cost.amount.toFixed(4)} estimated`;
  return `${u.completeness_pct}% complete · ${cost}`;
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
      <Panel title="Inputs"><Json value={d.run.inputs ?? {}} /></Panel>
      <Panel title="Node attempts">
        <Table head={['Node', 'Attempt', 'State', 'Worker', 'Output or error']} empty="No node has run yet.">
          {d.attempts.map((a: any) => (
            <tr key={`${a.node_id}/${a.attempt}`}>
              <td>{a.node_id}</td><td>{a.attempt}</td><td><StateBadge state={a.state} /></td><td className="mono">{a.worker_id ?? '—'}</td>
              <td>{a.error ? <Json value={a.error} /> : a.output !== null && a.output !== undefined ? <details><summary>output</summary><Json value={a.output} /></details> : '—'}</td>
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

export function Coverage({ plan: p, live }: { plan: RunPlan | null; live?: boolean }) {
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
      {live ? <p className="muted">This is the plan as it stands now, for you, with the workers online now.</p> : <p className="muted">This is the plan as it stood when the run was created.</p>}
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

function UsageTab({ usage: u }: { usage: any }) {
  if (!u.turns) return <p className="muted">No model usage in this run.</p>;
  return (
    <>
      <p>
        {u.turns} turn(s). Usage is known for {u.completeness_pct}% of them. Tokens: {num(u.input_tokens)} in, {num(u.output_tokens)} out.{' '}
        {u.cost.amount === null ? 'Cost is unavailable: at least one turn has no declared pricing or no token counts.' : `Estimated cost ${u.cost.currency} ${u.cost.amount.toFixed(4)} (pricing ${u.cost.pricing_revision}).`}
      </p>
      <Panel>
        <Table head={['Node', 'Turn', 'Executor', 'Model', 'In', 'Out', 'Cache read', 'Reasoning', 'Cost']}>
          {u.records.map((x: any, i: number) => (
            <tr key={i}>
              <td>{x.node_id}</td><td>{x.attempt}.{x.turn}</td><td>{x.executor}</td><td>{x.model ?? '—'}</td><td>{num(x.input_tokens)}</td><td>{num(x.output_tokens)}</td><td>{num(x.cache_read_tokens)}</td><td>{num(x.reasoning_tokens)}</td>
              <td>{x.cost_label === 'unavailable' ? 'unavailable' : `${x.cost?.toFixed?.(4) ?? x.cost} (${x.cost_label})`}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
