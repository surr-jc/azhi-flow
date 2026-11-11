import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, atLeast, type ScheduleRow, type TriggerDelivery, type TriggerRow } from '../api';
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
      <Triggers admin={admin} />
    </>
  );
}

/** Webhook triggers: the URL to give GitHub (or any sender), and what happened to each delivery. */
function Triggers({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['triggers'], queryFn: () => api<TriggerRow[]>('/v1/triggers'), refetchInterval: 10_000 });
  const log = useQuery({ queryKey: ['trigger-deliveries', open], queryFn: () => api<TriggerDelivery[]>(`/v1/triggers/${encodeURIComponent(open!)}/deliveries`), enabled: open !== null, refetchInterval: 5_000 });
  const toggle = useMutation({
    mutationFn: (t: TriggerRow) => api(`/v1/triggers/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { enabled: !t.enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['triggers'] }),
  });
  return (
    <Panel title="Event triggers">
      <p className="muted small">
        A signed webhook starts the latest published version. Sign the body with the workspace secret the trigger names (HMAC-SHA256, <code>X-Hub-Signature-256</code> for GitHub). Every delivery is listed here, including the ones that started nothing.
      </p>
      <ErrorNote error={q.error ?? toggle.error ?? log.error} />
      {!q.data ? <Loading /> : (
        <Table head={['Workflow', 'Source', 'Events', 'Webhook URL', 'Deliveries', 'State']} empty="No event triggers. Add trigger.events to a workflow and publish it.">
          {q.data.flatMap((t) => [
            <tr key={t.id}>
              <td><Link to={`/ui/workflows/${encodeURIComponent(t.workflow)}`}>{t.workflow}</Link></td>
              <td>{t.source}<div className="muted small">secret: {t.secret_name}</div></td>
              <td className="mono">{t.events.join(', ') || 'any'}{t.filter ? <div className="muted small">when {t.filter}</div> : null}</td>
              <td className="mono small" style={{ wordBreak: 'break-all' }}>{t.url}</td>
              <td>
                <button className="small" onClick={() => setOpen(open === t.id ? null : t.id)}>{t.deliveries} {open === t.id ? '▾' : '▸'}</button>
                <div className="muted small">{t.last_delivery_at ? ago(t.last_delivery_at) : 'none yet'}</div>
              </td>
              <td>
                {t.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="idle">off</Badge>}{' '}
                {admin ? <button className="small" disabled={toggle.isPending} onClick={() => toggle.mutate(t)}>{t.enabled ? 'Turn off' : 'Turn on'}</button> : null}
              </td>
            </tr>,
            ...(open === t.id
              ? [
                  <tr key={`${t.id}-log`}>
                    <td colSpan={6}>
                      {!log.data ? <Loading /> : log.data.length === 0 ? <span className="muted">No deliveries yet.</span> : (
                        <Table head={['Received', 'Event', 'Outcome', 'Run', 'Why']}>
                          {log.data.map((d) => (
                            <tr key={d.delivery_id}>
                              <td title={when(d.received_at)}>{ago(d.received_at)}</td>
                              <td className="mono">{d.event ?? '—'}</td>
                              <td><Badge tone={d.outcome === 'started' ? 'ok' : d.outcome === 'refused' ? 'bad' : 'idle'}>{d.outcome}</Badge></td>
                              <td>{d.run_id ? <RunLink id={d.run_id} /> : <span className="muted">none</span>}</td>
                              <td className="muted small">{d.reason ?? ''}</td>
                            </tr>
                          ))}
                        </Table>
                      )}
                    </td>
                  </tr>,
                ]
              : []),
          ])}
        </Table>
      )}
    </Panel>
  );
}
