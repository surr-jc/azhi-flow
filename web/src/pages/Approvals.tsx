import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Approval } from '../api';
import { Link } from '../router';
import { ago, Badge, ErrorNote, formValues, Json, Loading, PageHead, Panel, RunLink, SchemaFields, when } from '../ui';

export function Approvals() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api<Approval[]>('/v1/approvals'), refetchInterval: 5_000 });
  return (
    <>
      <PageHead title="Approvals" sub="Runs paused until a person decides. Each decision is checked against the approver's role and recorded in the run." />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Panel><p className="muted">Nothing is waiting for a decision.</p></Panel> : q.data.map((a) => <ApprovalCard key={`${a.run_id}/${a.node_id}`} approval={a} />)}
    </>
  );
}

export function ApprovalCard({ approval: a, compact }: { approval: Approval; compact?: boolean }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [formError, setFormError] = useState<string>();
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => {
      const data = decision === 'approved' ? formValues(a.decision_schema, values) : {};
      return api(`/v1/runs/${encodeURIComponent(a.run_id)}/approvals`, { method: 'POST', body: { node: a.node_id, decision, data } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['run', a.run_id] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const go = (d: 'approved' | 'rejected') => {
    setFormError(undefined);
    try {
      if (d === 'approved') formValues(a.decision_schema, values);
    } catch (e) {
      return setFormError((e as Error).message);
    }
    decide.mutate(d);
  };
  const message = typeof a.request.message === 'string' ? a.request.message : a.request.message === undefined ? null : JSON.stringify(a.request.message);
  return (
    <Panel
      title={
        <>
          {compact ? `Approval: ${a.node_id}` : <><Link to={`/ui/workflows/${encodeURIComponent(a.workflow)}`}>{a.workflow}</Link> · {a.node_id}</>}
          {a.test ? <> <Badge tone="idle">test run</Badge></> : null}
        </>
      }
      action={!compact ? <RunLink id={a.run_id} /> : undefined}
    >
      {message ? <p className="approval-message">{message}</p> : null}
      {a.request.payload !== undefined && a.request.payload !== null ? (
        <details open>
          <summary>What will happen if approved</summary>
          <Json value={a.request.payload} />
        </details>
      ) : null}
      <p className="muted small">
        Requested {ago(a.requested_at)} · needs role {a.role} or higher
        {a.expires_at ? <> · expires {ago(a.expires_at)} ({when(a.expires_at)}), then {a.request.on_expiry === 'fail' ? 'the run fails' : 'it counts as rejected'}</> : null}
      </p>
      {decide.isSuccess ? (
        <p className="ok-note">Decision sent. The run continues from here.</p>
      ) : a.can_decide ? (
        <>
          {a.decision_schema?.properties && Object.keys(a.decision_schema.properties).length ? <SchemaFields schema={a.decision_schema} values={values} onChange={setValues} /> : null}
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
    </Panel>
  );
}
