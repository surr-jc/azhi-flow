import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, atLeast, type Approval } from '../api';
import { useMe } from '../App';
import { Link } from '../router';
import { Formatted, Markdown } from '../components/Rich';
import { DiffView, looksLikeDiff } from '../components/DiffView';
import { ChangeReview, isChangeReview } from '../components/ChangeReview';
import { choicesComplete, composeAnswers, OpenQuestions, readOpenQuestions, type QuestionChoice } from '../components/OpenQuestions';
import { ago, ErrorNote, formValues, Loading, PageHead, Panel, RunLink, SchemaFields, when } from '../ui';

export function Approvals() {
  const me = useMe();
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api<Approval[]>('/v1/approvals'), refetchInterval: 5_000 });
  return (
    <>
      <PageHead title="Approvals" sub="Runs paused until a person decides. Each decision is checked against the approver's role and recorded in the run." />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Panel><p className="muted">Nothing is waiting for a decision.</p></Panel> : q.data.map((a) => <ApprovalCard key={`${a.run_id}/${a.node_id}`} approval={a} />)}
      {atLeast(me.data?.role, 'admin') ? <p className="muted small">Slack approvals, runs and chat are set up under <Link to="/ui/slack">System, Slack</Link>.</p> : null}
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

/** The decision form without its free-text `answers` field, which the question selector replaces. */
function withoutAnswers(schema: Approval['decision_schema']): Approval['decision_schema'] {
  if (!schema?.properties || !('answers' in schema.properties)) return schema;
  const { answers: _answers, ...properties } = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((k: string) => k !== 'answers') : schema.required;
  return { ...schema, properties, required } as Approval['decision_schema'];
}

export function ApprovalCard({ approval: a, compact }: { approval: Approval; compact?: boolean }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const questions = readOpenQuestions(a.request.payload);
  const pickable = questions.length > 0 && Boolean(a.decision_schema?.properties && 'answers' in a.decision_schema.properties);
  const [choices, setChoices] = useState<QuestionChoice[]>([]);
  const formSchema = pickable ? withoutAnswers(a.decision_schema) : a.decision_schema;
  const formHasFields = Boolean(formSchema?.properties && Object.keys(formSchema.properties).length);
  const [formError, setFormError] = useState<string>();
  const decide = useDecide(a);
  const go = (d: 'approved' | 'rejected') => {
    setFormError(undefined);
    let data: Record<string, unknown> = {};
    try {
      if (d === 'approved') {
        if (pickable && !choicesComplete(questions, choices)) throw new Error('Pick an option for every question, or write your own answer.');
        data = formValues(formSchema, values);
        if (pickable) data.answers = composeAnswers(questions, choices);
      }
    } catch (e) {
      return setFormError((e as Error).message);
    }
    decide.mutate({ decision: d, data });
  };
  const payload = a.request.payload;
  // A change set is shown on its own as a diff, and the rest of the payload stays as readable fields.
  const diffText = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { diff?: unknown }).diff === 'string' && looksLikeDiff((payload as { diff: string }).diff) ? (payload as { diff: string }).diff : undefined;
  const restPayload = diffText ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => k !== 'diff')) : payload;
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
        {a.request.context_withheld?.length ? (
          <p className="muted small" role="note">
            <strong>An agent before this step was not sent</strong> {a.request.context_withheld.map((f, i) => <span key={f}>{i ? ', ' : ''}<code>{f}</code></span>)} (over its input cap). It could not read {a.request.context_withheld.length === 1 ? 'it' : 'them'}, so check what it decided without.
          </p>
        ) : null}
        {isChangeReview(payload) ? (
          <ChangeReview payload={payload} />
        ) : payload !== undefined && payload !== null ? (
          <>
            {diffText ? <h3 className="small payload-title">What changes</h3> : null}
            {diffText ? <div className="payload"><DiffView text={diffText} /></div> : null}
            {diffText ? <h3 className="small payload-title">Details</h3> : null}
            <div className="payload"><Formatted value={restPayload} rawLabel="the full payload as JSON" /></div>
          </>
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
            {pickable ? <OpenQuestions questions={questions} choices={choices} onChange={setChoices} idPrefix={`oq-${a.node_id}`} /> : null}
            {needsForm(a) && (!pickable || formHasFields) ? <SchemaFields schema={formSchema} values={values} onChange={setValues} idPrefix={`d-${a.node_id}`} /> : null}
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
