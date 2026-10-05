import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, atLeast, type Alert } from '../api';
import { useMe } from '../App';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Loading, PageHead, Panel, RunLink, Table, when } from '../ui';
import { AlertList } from './Overview';

interface HistoryRow { key: string; level: Alert['level']; kind: string; message: string; run_id: string | null; workflow: string | null; first_seen: string; last_seen: string; resolved_at: string | null; notified_at: string | null; notify_error: string | null }
interface Settings { slack_channel: string | null; min_level: 'critical' | 'warning'; enabled: boolean; slack_token_set: boolean }

export function Alerts() {
  const me = useMe();
  const current = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('/v1/alerts'), refetchInterval: 15_000 });
  const history = useQuery({ queryKey: ['alerts', 'history'], queryFn: () => api<HistoryRow[]>('/v1/alerts/history?limit=100'), refetchInterval: 30_000 });
  return (
    <>
      <PageHead title="Alerts" sub="Raised from what the server already knows: failed runs, writes with an unknown outcome, offline workers, expiring approvals, spend limits and blocked schedules." />
      <div className="grid-2">
        <Panel title="Now">
          <ErrorNote error={current.error} />
          {current.data ? <AlertList alerts={current.data} /> : <Loading />}
        </Panel>
        <Panel title="Send alerts to Slack">
          {atLeast(me.data?.role, 'admin') ? <SlackSettings /> : <p className="muted">An admin can choose a Slack channel for alerts.</p>}
        </Panel>
      </div>
      <Panel title="History">
        <ErrorNote error={history.error} />
        {!history.data ? <Loading /> : (
          <Table head={['Alert', 'Raised', 'Cleared', 'Slack']} empty="No alerts recorded yet. The server checks once a minute.">
            {history.data.map((h) => (
              <tr key={h.key}>
                <td>
                  <Badge tone={h.level === 'critical' ? 'bad' : h.level === 'warning' ? 'warn' : 'idle'}>{h.level}</Badge> {h.message}
                  {h.run_id ? <> · <RunLink id={h.run_id} /></> : h.workflow ? <> · <Link to={`/ui/workflows/${encodeURIComponent(h.workflow)}`}>{h.workflow}</Link></> : null}
                </td>
                <td title={when(h.first_seen)} className="nowrap">{ago(h.first_seen)}</td>
                <td className="nowrap">{h.resolved_at ? <span title={when(h.resolved_at)}>{ago(h.resolved_at)}</span> : <Badge tone="warn">open</Badge>}</td>
                <td>{h.notified_at ? <span title={when(h.notified_at)}>sent</span> : h.notify_error ? <span className="warn-text" title={h.notify_error}>failed: {h.notify_error}</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}

function SlackSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'alerts'], queryFn: () => api<Settings>('/v1/settings/alerts') });
  const [channel, setChannel] = useState('');
  const [level, setLevel] = useState<'critical' | 'warning'>('warning');
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (!q.data) return;
    setChannel(q.data.slack_channel ?? '');
    setLevel(q.data.min_level);
    setEnabled(q.data.enabled);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/v1/settings/alerts', { method: 'PUT', body: { slack_channel: channel.trim() || null, min_level: level, enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'alerts'] }),
  });
  const test = useMutation({ mutationFn: () => api('/v1/settings/alerts/test', { method: 'POST', body: {} }) });
  if (!q.data) return <Loading />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    test.reset();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="fields">
      {!q.data.slack_token_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-bot-token</code> first; alerts use the same Slack bot as your workflows.</p> : null}
      <div className="field">
        <label htmlFor="alert-channel">Channel ID</label>
        <input id="alert-channel" className="mono" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123456789" />
        <span className="hint">In Slack, open the channel's details to copy its ID, and invite the bot to the channel.</span>
      </div>
      <div className="field">
        <label htmlFor="alert-level">Send</label>
        <select id="alert-level" value={level} onChange={(e) => setLevel(e.target.value as 'critical' | 'warning')}>
          <option value="warning">Critical and warning alerts</option>
          <option value="critical">Critical alerts only</option>
        </select>
      </div>
      <div className="field inline">
        <input id="alert-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <label htmlFor="alert-enabled">Sending is on</label>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>Save</button>
        <button type="button" disabled={test.isPending || !q.data.slack_channel || save.isPending} onClick={() => test.mutate()}>Send a test message</button>
      </div>
      {save.isSuccess && !test.data ? <p className="ok-note">Saved. New alerts go to Slack once each, within a minute.</p> : null}
      {test.isSuccess ? <p className="ok-note">Test message posted.</p> : null}
      <ErrorNote error={save.error ?? test.error} />
    </form>
  );
}
