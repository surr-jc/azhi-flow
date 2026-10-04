import { useQuery } from '@tanstack/react-query';
import { api, type Alert, type Overview as OverviewData, type RunRow } from '../api';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Loading, money, PageHead, Panel, RunLink, Stat, StateBadge, Table, when } from '../ui';

export function Overview() {
  const o = useQuery({ queryKey: ['overview'], queryFn: () => api<OverviewData>('/v1/overview'), refetchInterval: 5_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('/v1/alerts'), refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ['runs', 'recent'], queryFn: () => api<RunRow[]>('/v1/runs?limit=10'), refetchInterval: 5_000 });
  if (o.error) return <ErrorNote error={o.error} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const failed = (d.last_24h.failed ?? 0) + (d.last_24h.delivery_failed ?? 0) + (d.last_24h.expired ?? 0);
  return (
    <>
      <PageHead title="Mission control" sub={`Updated ${new Date(o.dataUpdatedAt).toLocaleTimeString()}`} />
      <div className="stats">
        <Stat label="Running" value={(d.open.running ?? 0) + (d.open.queued ?? 0)} hint={d.open.queued ? `${d.open.queued} queued` : 'now'} tone="run" to="/ui/runs?state=running,queued" />
        <Stat label="Waiting" value={d.open.waiting ?? 0} hint="approval or worker" tone={d.open.waiting ? 'warn' : ''} to="/ui/runs?state=waiting" />
        <Stat label="Needs you" value={d.approvals.mine} hint={`${d.approvals.pending} approval${d.approvals.pending === 1 ? '' : 's'} pending`} tone={d.approvals.mine ? 'warn' : ''} to="/ui/approvals" />
        <Stat label="Succeeded (24 h)" value={d.last_24h.succeeded ?? 0} tone="ok" to="/ui/runs?state=succeeded" />
        <Stat label="Failed (24 h)" value={failed} tone={failed ? 'bad' : ''} to="/ui/runs?state=failed,delivery_failed,expired" />
        <Stat label="Workers online" value={`${d.workers.online}/${d.workers.total}`} tone={d.workers.online ? 'ok' : 'bad'} to="/ui/workers" />
        <Stat label="Model spend today" value={money(d.spend.today.amount, d.spend.today.currency, d.spend.today.complete)} hint={spendHint(d.spend.today)} to="/ui/usage" />
        <Stat label="Model spend 7 days" value={money(d.spend.week.amount, d.spend.week.currency, d.spend.week.complete)} hint={spendHint(d.spend.week)} to="/ui/usage" />
      </div>

      <div className="grid-2">
        <Panel title="Alerts">
          {alerts.data ? <AlertList alerts={alerts.data} /> : <Loading />}
        </Panel>
        <Panel title="Next scheduled runs" action={<Link to="/ui/schedules">All schedules</Link>}>
          <Table head={['Workflow', 'Next', 'Last run']} empty="No schedules are enabled.">
            {d.schedules.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/ui/workflows/${encodeURIComponent(s.workflow)}`}>{s.workflow}</Link></td>
                <td title={when(s.next_occurrence_at)}>{ago(s.next_occurrence_at)}</td>
                <td>{s.last_run ? <StateBadge state={s.last_run.state} /> : <span className="muted">none yet</span>}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>

      <Panel title="Recent runs" action={<Link to="/ui/runs">All runs</Link>}>
        {runs.data ? <RunTable runs={runs.data} /> : <Loading />}
      </Panel>
    </>
  );
}

function spendHint(s: OverviewData['spend']['today']) {
  if (!s.turns) return 'no model turns';
  return s.complete ? `${s.turns} turns` : `${s.unpriced_turns} of ${s.turns} turns unpriced`;
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

export function RunTable({ runs, empty = 'No runs yet.' }: { runs: RunRow[]; empty?: string }) {
  return (
    <Table head={['Run', 'Workflow', 'State', 'Trigger', 'Started', 'Took']} empty={empty}>
      {runs.map((r) => (
        <tr key={r.id}>
          <td><RunLink id={r.id} /></td>
          <td><Link to={`/ui/workflows/${encodeURIComponent(r.workflow)}`}>{r.workflow}</Link><span className="muted">@{r.version}</span></td>
          <td>
            <StateBadge state={r.state} />
            {r.test ? <> <Badge tone="idle">test</Badge></> : null}
            {r.flags?.waiting_reason ? <span className="muted small"> {r.flags.waiting_reason.reason.replace('_', ' ')}</span> : null}
          </td>
          <td>{r.trigger}</td>
          <td title={when(r.created_at)}>{ago(r.created_at)}</td>
          <td>{r.ended_at ? duration(r.created_at, r.ended_at) : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

export function duration(a: string, b: string) {
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
