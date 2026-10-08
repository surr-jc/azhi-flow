import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, atLeast, type Approval } from '../api';
import { useMe } from '../App';
import { Link } from '../router';
import { Formatted, Markdown } from '../components/Rich';
import { ago, ErrorNote, formValues, Loading, PageHead, Panel, RunLink, SchemaFields, when } from '../ui';

export function Approvals() {
  const me = useMe();
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api<Approval[]>('/v1/approvals'), refetchInterval: 5_000 });
  return (
    <>
      <PageHead title="Approvals" sub="Runs paused until a person decides. Each decision is checked against the approver's role and recorded in the run." />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Panel><p className="muted">Nothing is waiting for a decision.</p></Panel> : q.data.map((a) => <ApprovalCard key={`${a.run_id}/${a.node_id}`} approval={a} />)}
      {atLeast(me.data?.role, 'admin') ? <details className="panel"><summary>Approvals in Slack</summary><SlackApprovals /></details> : null}
    </>
  );
}

const ROLE_WHO: Record<string, string> = { viewer: 'Anyone', author: 'Authors and above', operator: 'Operators and above', admin: 'Admins and owners', owner: 'Owners' };
export const whoCanDecide = (role: string) => ROLE_WHO[role] ?? `${role} and above`;

/** The approval's question in words: its message, or which step is asking. */
export function approvalQuestion(a: Approval): string {
  const m = a.request.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (m !== undefined && m !== null) return JSON.stringify(m);
  return `Approve ${a.node_id} in ${a.workflow}?`;
}

/** Approve or reject one waiting approval, refreshing everything that shows it. */
export function useDecide(a: Approval) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, data }: { decision: 'approved' | 'rejected'; data?: Record<string, unknown> }) =>
      api(`/v1/runs/${encodeURIComponent(a.run_id)}/approvals`, { method: 'POST', body: { node: a.node_id, decision, data: data ?? {} } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['run', a.run_id] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
}

/** True when the approver must fill in a form, so a one-click approve is not enough. */
export const needsForm = (a: Approval) => Boolean(a.decision_schema?.properties && Object.keys(a.decision_schema.properties).length);

export function ApprovalCard({ approval: a, compact }: { approval: Approval; compact?: boolean }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [formError, setFormError] = useState<string>();
  const decide = useDecide(a);
  const go = (d: 'approved' | 'rejected') => {
    setFormError(undefined);
    let data: Record<string, unknown> = {};
    try {
      if (d === 'approved') data = formValues(a.decision_schema, values);
    } catch (e) {
      return setFormError((e as Error).message);
    }
    decide.mutate({ decision: d, data });
  };
  const payload = a.request.payload;
  const expiry = a.expires_at ? `Expires ${ago(a.expires_at)} (${when(a.expires_at)}), then ${a.request.on_expiry === 'fail' ? 'the run fails' : 'it counts as rejected'}` : null;
  return (
    <section className="decision" aria-label={`Approval ${a.node_id}`}>
      <header>
        <span>{a.can_decide ? 'Your decision' : 'Waiting for a decision'}{a.test ? ' · test run' : ''}</span>
        {expiry ? <span>{expiry}</span> : null}
      </header>
      <div className="body">
        {!compact ? (
          <div className="crumbs">
            <Link to={`/ui/workflows/${encodeURIComponent(a.workflow)}`}>{a.workflow}</Link> · step {a.node_id} · requested {ago(a.requested_at)} · <RunLink id={a.run_id} />
          </div>
        ) : null}
        <div className="question"><Markdown text={approvalQuestion(a)} inline={!approvalQuestion(a).includes('\n')} /></div>
        {payload !== undefined && payload !== null ? (
          <div className="payload"><Formatted value={payload} rawLabel="the full payload as JSON" /></div>
        ) : (
          <p className="muted small">The workflow shows the approver no details for this step.</p>
        )}
        <p className="who">
          {whoCanDecide(a.role)} can decide.{compact ? ` Requested ${ago(a.requested_at)}.` : ''}
        </p>
        {decide.isSuccess ? (
          <p className="ok-note" role="status">Decision recorded. The run continues from here.</p>
        ) : a.can_decide ? (
          <>
            {needsForm(a) ? <SchemaFields schema={a.decision_schema} values={values} onChange={setValues} idPrefix={`d-${a.node_id}`} /> : null}
            <div className="row">
              <button className="primary" disabled={decide.isPending} onClick={() => go('approved')}>Approve</button>
              <button className="danger" disabled={decide.isPending} onClick={() => go('rejected')}>Reject</button>
            </div>
          </>
        ) : (
          <p className="muted">Your role cannot decide this one.</p>
        )}
        {formError ? <div className="error">{formError}</div> : null}
        <ErrorNote error={decide.error} />
      </div>
    </section>
  );
}

interface ApprovalSettings { slack_channel: string | null; slack_token_set: boolean; signing_secret_set: boolean; interactivity_url: string }

/** Where waiting approvals are posted with Approve and Reject buttons, and what Slack needs. */
function SlackApprovals() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'approvals'], queryFn: () => api<ApprovalSettings>('/v1/settings/approvals') });
  const [channel, setChannel] = useState('');
  useEffect(() => setChannel(q.data?.slack_channel ?? ''), [q.data]);
  const save = useMutation({
    mutationFn: () => api('/v1/settings/approvals', { method: 'PUT', body: { slack_channel: channel.trim() || null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'approvals'] }),
  });
  if (!q.data) return <Loading />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="fields">
      <p className="muted small">Each waiting approval is posted once to this channel with Approve and Reject buttons. A click counts only for a Slack user linked to an Azhi Flow user (on the <Link to="/ui/users">Users</Link> page), with that user's role. Decisions that need a form are made here.</p>
      {!q.data.slack_token_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-bot-token</code>.</p> : null}
      {!q.data.signing_secret_set ? <p className="warn-note">Set the <Link to="/ui/secrets">secret</Link> <code>slack-signing-secret</code> (the Slack app's signing secret), so button clicks can be verified.</p> : null}
      <div className="field">
        <label htmlFor="approval-channel">Channel ID</label>
        <input id="approval-channel" className="mono" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123456789" />
      </div>
      <div className="field">
        <span className="small">In the Slack app's settings, turn on Interactivity with this request URL:</span>
        <code className="mono small">{q.data.interactivity_url}</code>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>Save</button>
        {save.isSuccess ? <span className="ok-note">Saved.</span> : null}
      </div>
      <ErrorNote error={save.error} />
    </form>
  );
}
