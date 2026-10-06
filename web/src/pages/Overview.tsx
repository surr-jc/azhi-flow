import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, TERMINAL, type Alert, type Approval, type Overview as OverviewData, type RunRow } from '../api';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Loading, money, num, PageHead, RunLink, StateBadge, Table, when } from '../ui';
import { approvalQuestion, needsForm, useDecide, whoCanDecide } from './Approvals';

export function Overview() {
  const o = useQuery({ queryKey: ['overview'], queryFn: () => api<OverviewData>('/v1/overview'), refetchInterval: 5_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('/v1/alerts'), refetchInterval: 15_000 });
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: () => api<Approval[]>('/v1/approvals'), refetchInterval: 5_000 });
  const open = useQuery({ queryKey: ['runs', 'open'], queryFn: () => api<RunRow[]>('/v1/runs?state=running,queued,waiting,cancelling&limit=10'), refetchInterval: 5_000 });
  const done = useQuery({ queryKey: ['runs', 'finished'], queryFn: () => api<RunRow[]>(`/v1/runs?state=${TERMINAL.join(',')}&limit=5`), refetchInterval: 10_000 });
  if (o.error) return <ErrorNote error={o.error} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const waiting = [...(approvals.data ?? [])].sort((a, b) => Number(b.can_decide) - Number(a.can_decide) || (a.expires_at ?? '9').localeCompare(b.expires_at ?? '9'));
  const mine = waiting.filter((a) => a.can_decide).length;
  // Runs paused on an approval already show above, as decisions.
  const decided = new Set(waiting.map((a) => a.run_id));
  const running = (open.data ?? []).filter((r) => !decided.has(r.id));
  const day = d.last_24h;
  const failed = (day.failed ?? 0) + (day.delivery_failed ?? 0) + (day.expired ?? 0);
  const total = Object.values(day).reduce((n, x) => n + (x ?? 0), 0);
  const next = d.schedules.find((s) => s.next_occurrence_at);
  return (
    <>
      <PageHead
        title={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        sub={[
          mine ? `${mine} decision${mine === 1 ? '' : 's'} waiting for you` : 'Nothing is waiting for you',
          `${running.length} run${running.length === 1 ? '' : 's'} in progress`,
          next ? `next scheduled run ${ago(next.next_occurrence_at)}` : null,
        ].filter(Boolean).join(' · ')}
      />
      <StatusTiles o={d} />
      <div className="today">
        <div className="today-main">
          <section className="today-sec" aria-labelledby="t-decisions">
            <header><h2 id="t-decisions">Waiting for a decision</h2>{waiting.length ? <Link to="/ui/approvals" className="small">All approvals</Link> : null}</header>
            {!approvals.data ? <Loading /> : waiting.length ? waiting.map((a) => <DecisionRow key={`${a.run_id}/${a.node_id}`} a={a} />) : <p className="today-empty">No run is waiting for a person. New approvals appear here first.</p>}
          </section>

          <section className="today-sec" aria-labelledby="t-running">
            <header><h2 id="t-running">Running now</h2><Link to="/ui/runs?state=running,queued,waiting" className="small">All open runs</Link></header>
            {!open.data ? <Loading /> : running.length ? running.map((r) => <RunRowLink key={r.id} r={r} />) : <p className="today-empty">No runs in progress.</p>}
          </section>

          {alerts.data?.length ? (
            <section className="today-sec" aria-labelledby="t-alerts">
              <header><h2 id="t-alerts">Needs attention</h2><Link to="/ui/alerts" className="small">Alerts and Slack</Link></header>
              <div className="card"><AlertList alerts={alerts.data} /></div>
            </section>
          ) : null}

          <section className="today-sec" aria-labelledby="t-done">
            <header><h2 id="t-done">Recently finished</h2><Link to="/ui/runs" className="small">All runs</Link></header>
            {!done.data ? <Loading /> : done.data.length ? done.data.map((r) => <RunRowLink key={r.id} r={r} />) : <p className="today-empty">No run has finished yet. Start one from <Link to="/ui/workflows">Workflows</Link>.</p>}
          </section>
        </div>

        <aside className="side-col" aria-label="Summary">
          <Link to="/ui/usage" className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
            <h3>Model spend <span className="small">Limits</span></h3>
            <div className="kv-list">
              <div><span>Today</span><span>{money(d.spend.today.amount, d.spend.today.currency, d.spend.today.complete)}</span></div>
              <div><span>Last 7 days</span><span>{money(d.spend.week.amount, d.spend.week.currency, d.spend.week.complete)}</span></div>
            </div>
            <span className="small muted">{spendHint(d.spend.week)}</span>
          </Link>
          <div className="card">
            <h3>Coming up <Link to="/ui/schedules" className="small">Schedules</Link></h3>
            {d.schedules.length ? (
              <div className="kv-list">
                {d.schedules.slice(0, 5).map((s) => (
                  <div key={s.id}><Link to={`/ui/workflows/${encodeURIComponent(s.workflow)}`}>{s.workflow}</Link><span title={when(s.next_occurrence_at)}>{s.next_occurrence_at ? ago(s.next_occurrence_at) : 'not planned'}</span></div>
                ))}
              </div>
            ) : <p className="muted small">No schedules are on.</p>}
          </div>
          <div className="card">
            <h3>System</h3>
            <div className="kv-list">
              <div><Link to="/ui/workers">Workers</Link><Badge tone={`s ${d.workers.online ? 'ok' : 'bad'}`}>{d.workers.online} of {d.workers.total} online</Badge></div>
              <div><Link to="/ui/alerts">Alerts</Link>{alerts.data?.length ? <Badge tone={`s ${alerts.data.some((a) => a.level === 'critical') ? 'bad' : 'warn'}`}>{alerts.data.length} open</Badge> : <Badge tone="s ok">all clear</Badge>}</div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

/** The mission control strip: the system's state in numbers, each one a way into the runs behind it. */
export function StatusTiles({ o, active }: { o: OverviewData; active?: string }) {
  const day = o.last_24h;
  const open = o.open;
  const failed = (day.failed ?? 0) + (day.delivery_failed ?? 0) + (day.expired ?? 0);
  const tiles: Array<{ key: string; label: string; value: string; sub: string; to: string; tone?: string }> = [
    { key: 'running,queued', label: 'Running', value: num((open.running ?? 0) + (open.queued ?? 0)), sub: open.queued ? `${num(open.queued)} queued` : 'now', to: '/ui/runs?state=running,queued', tone: (open.running ?? 0) + (open.queued ?? 0) ? 'run' : undefined },
    { key: 'waiting', label: 'Waiting', value: num(open.waiting ?? 0), sub: 'on a person or worker', to: '/ui/runs?state=waiting', tone: open.waiting ? 'warn' : undefined },
    { key: 'approvals', label: 'Needs you', value: num(o.approvals.mine), sub: `${num(o.approvals.pending)} approval${o.approvals.pending === 1 ? '' : 's'} pending`, to: '/ui/approvals', tone: o.approvals.mine ? 'warn' : undefined },
    { key: 'succeeded', label: 'Succeeded', value: num(day.succeeded ?? 0), sub: 'last 24 hours', to: '/ui/runs?state=succeeded', tone: day.succeeded ? 'ok' : undefined },
    { key: 'failed,delivery_failed,expired', label: 'Failed', value: num(failed), sub: 'last 24 hours', to: '/ui/runs?state=failed,delivery_failed,expired', tone: failed ? 'bad' : undefined },
    { key: 'workers', label: 'Workers online', value: `${o.workers.online}/${o.workers.total}`, sub: o.workers.online ? 'ready for steps' : 'no worker can run steps', to: '/ui/workers', tone: o.workers.online ? 'ok' : 'bad' },
    { key: 'spend', label: 'Spend today', value: money(o.spend.today.amount, o.spend.today.currency, o.spend.today.complete), sub: `${money(o.spend.week.amount, o.spend.week.currency, o.spend.week.complete)} this week`, to: '/ui/usage' },
  ];
  return (
    <nav className="tiles" aria-label="System status">
      {tiles.map((t) => (
        <Link key={t.key} to={t.to} className={`tile${active === t.key ? ' active' : ''}`} aria-current={active === t.key ? 'true' : undefined}>
          <span className="tile-label">{t.label}</span>
          <span className={`tile-value ${t.tone ?? ''}`}>{t.value}</span>
          <span className="tile-sub">{t.sub}</span>
        </Link>
      ))}
    </nav>
  );
}

function DecisionRow({ a }: { a: Approval }) {
  const decide = useDecide(a);
  const soon = a.expires_at && new Date(a.expires_at).getTime() - Date.now() < 3600_000;
  return (
    <div className="decision-row">
      <div className="what">
        <span className="q">{approvalQuestion(a)}</span>
        <span className="meta-line">
          {a.workflow}{a.test ? ' (test run)' : ''} · {whoCanDecide(a.role).toLowerCase()} can decide
          {a.expires_at ? <> · <span className={soon ? 'soon' : ''}>expires {ago(a.expires_at)}</span></> : null}
        </span>
      </div>
      {decide.isSuccess ? (
        <span className="ok-note" role="status">Approved</span>
      ) : (
        <div className="row">
          <Link to={`/ui/runs/${encodeURIComponent(a.run_id)}`} className="button">Review</Link>
          {a.can_decide && !needsForm(a) ? <button className="primary" disabled={decide.isPending} onClick={() => decide.mutate({ decision: 'approved' })}>Approve</button> : null}
        </div>
      )}
      {decide.error ? <div style={{ flexBasis: '100%' }}><ErrorNote error={decide.error} /></div> : null}
    </div>
  );
}

function RunRowLink({ r }: { r: RunRow }) {
  const waitingFor = r.flags?.waiting_reason?.reason?.replaceAll('_', ' ');
  return (
    <Link to={`/ui/runs/${encodeURIComponent(r.id)}`} className="run-row">
      <span>
        <span className="name">{r.workflow}</span> <span className="muted small">v{r.version}{r.test ? ' · test' : ''}</span>
        <span className="sub" style={{ display: 'block' }}>
          {r.trigger} · started {ago(r.created_at)}
          {r.ended_at ? ` · took ${duration(r.created_at, r.ended_at)}` : ''}
          {waitingFor ? ` · waiting for ${waitingFor}` : ''}
        </span>
      </span>
      <span className="right"><StateBadge state={r.state} /></span>
    </Link>
  );
}

function spendHint(s: OverviewData['spend']['today']) {
  if (!s.turns) return 'No model calls in the last 7 days.';
  const credits = s.credits ? `, ${num(Math.round(s.credits * 10) / 10)} Copilot credits` : '';
  return (s.complete ? `${num(s.turns)} model calls` : `${s.unpriced_turns} of ${s.turns} model calls have no price`) + credits + ' in the last 7 days.';
}

export function AlertList({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return <p className="muted">All clear. Nothing needs attention.</p>;
  return (
    <ul className="alerts">
      {alerts.map((a, i) => (
        <li key={i} className={`alert ${a.level}`}>
          <Badge tone={a.level === 'critical' ? 'bad' : a.level === 'warning' ? 'warn' : 'idle'}>{a.level}</Badge>
          <span>
            {a.message}
            {a.run_id ? <> · <RunLink id={a.run_id} /></> : null}
            {a.at ? <span className="muted"> · {ago(a.at)}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RunTable({ runs, empty = 'No runs yet.', cancel, inputs }: { runs: RunRow[]; empty?: string; cancel?: boolean; inputs?: boolean }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: (id: string) => api(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  });
  return (
    <>
    <ErrorNote error={stop.error} />
    <Table head={['Run', 'Workflow', 'State', ...(inputs ? ['Inputs'] : []), 'Trigger', 'Started', 'Took', ...(cancel ? [''] : [])]} empty={empty}>
      {runs.map((r) => (
        <tr key={r.id}>
          <td><RunLink id={r.id} /></td>
          <td><Link to={`/ui/workflows/${encodeURIComponent(r.workflow)}`}>{r.workflow}</Link><span className="muted">@{r.version}</span></td>
          <td>
            <StateBadge state={r.state} />
            {r.test ? <> <Badge tone="idle">test</Badge></> : null}
            {r.flags?.waiting_reason ? <span className="muted small"> {r.flags.waiting_reason.reason.replace('_', ' ')}</span> : null}
          </td>
          {inputs ? <td className="mono small inputs-cell">{JSON.stringify(r.inputs ?? {})}</td> : null}
          <td>{r.trigger}</td>
          <td title={when(r.created_at)}>{ago(r.created_at)}</td>
          <td>{r.ended_at ? duration(r.created_at, r.ended_at) : '—'}</td>
          {cancel ? (
            <td>
              {!TERMINAL.includes(r.state) && r.state !== 'cancelling' ? (
                <button type="button" className="small danger" aria-label={`Cancel ${r.id}`} disabled={stop.isPending && stop.variables === r.id} onClick={() => confirm(`Cancel ${r.id}?`) && stop.mutate(r.id)}>Cancel</button>
              ) : null}
            </td>
          ) : null}
        </tr>
      ))}
    </Table>
    </>
  );
}

export function duration(a: string, b: string) {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
