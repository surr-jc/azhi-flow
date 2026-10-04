import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, atLeast, type ScheduleRow } from '../api';
import { useMe } from '../App';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Json, Loading, PageHead, Panel, RunLink, StateBadge, Table, when } from '../ui';

export function Schedules() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['schedules'], queryFn: () => api<ScheduleRow[]>('/v1/schedules/summary'), refetchInterval: 10_000 });
  const toggle = useMutation({
    mutationFn: (s: ScheduleRow) => api(`/v1/schedules/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { enabled: !s.enabled } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const admin = atLeast(me.data?.role, 'admin');
  return (
    <>
      <PageHead title="Schedules" sub="Each occurrence runs the latest published version once, even across restarts. Cron and inputs come from the workflow or azhi schedule." />
      <ErrorNote error={q.error ?? toggle.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['Workflow', 'Cron', 'Next', 'Last run', 'Inputs', 'State']} empty="No schedules. A workflow with a schedule trigger gets one when it is published.">
            {q.data.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/ui/workflows/${encodeURIComponent(s.workflow)}`}>{s.workflow}</Link></td>
                <td className="mono">{s.cron}<div className="muted small">{s.timezone}</div></td>
                <td title={when(s.next_occurrence_at)}>{s.enabled ? ago(s.next_occurrence_at) : '—'}</td>
                <td>{s.last_run ? <><StateBadge state={s.last_run.state} /> <RunLink id={s.last_run.id} /></> : <span className="muted">none yet</span>}</td>
                <td>{Object.keys(s.inputs ?? {}).length ? <details><summary>{Object.keys(s.inputs).length} input(s)</summary><Json value={s.inputs} /></details> : <span className="muted">none</span>}</td>
                <td>
                  {s.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="idle">off</Badge>}{' '}
                  {admin ? <button className="small" disabled={toggle.isPending} onClick={() => toggle.mutate(s)}>{s.enabled ? 'Turn off' : 'Turn on'}</button> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
