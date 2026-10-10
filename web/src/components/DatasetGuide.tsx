import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorNote, Panel } from '../ui';

interface Starter { name: string; title: string; why: string; doc: { path: string; content: string } }

/** Starting points: a dataset name, what it is good for, and one document that shows the shape to follow. */
const STARTERS: Starter[] = [
  { name: 'runbooks', title: 'Team runbooks', why: 'Step-by-step operating procedures an on-call agent can look up and quote.', doc: { path: 'restart-a-service.md', content: '# Restart a service\n\n## When to use\n\nThe service is up but not answering health checks.\n\n## Steps\n\n1. Check the dashboard for error spikes.\n2. Restart one instance, then wait two minutes.\n3. If the error rate drops, restart the rest one at a time.\n\n## Escalate when\n\nThe error rate is unchanged after two restarts.\n' } },
  { name: 'engineering-guidelines', title: 'Engineering guidelines', why: 'Coding standards, review rules and quality bars, so reviews cite your rules, not generic advice.', doc: { path: 'code-review.md', content: '# Code review guidelines\n\n## What blocks a merge\n\n- A change without a test for the new behaviour.\n- A new dependency without a reason in the description.\n\n## What is only a suggestion\n\nNaming and formatting that the linter does not enforce.\n' } },
  { name: 'decisions', title: 'Architecture decisions', why: 'Why things are the way they are, so an agent does not suggest what you already ruled out.', doc: { path: '0001-use-postgres.md', content: '# 0001: Use PostgreSQL for the main store\n\n## Status\n\nAccepted\n\n## Context\n\nWe need transactions and a mature ecosystem.\n\n## Decision\n\nUse PostgreSQL.\n\n## Consequences\n\nWe run and back up a database ourselves.\n' } },
  { name: 'postmortems', title: 'Incident postmortems', why: 'What went wrong before and what fixed it, for root-cause work and incident triage.', doc: { path: '2026-01-payments-outage.md', content: '# Payments outage, January\n\n## Impact\n\nCheckout failed for 25 minutes.\n\n## Root cause\n\nA connection pool limit was lowered by a config change.\n\n## What fixed it\n\nReverting the change.\n\n## Follow-ups\n\n- Alert on pool saturation.\n' } },
  { name: 'product-docs', title: 'API and product docs', why: 'The facts about your product and API that support and review agents should quote.', doc: { path: 'refunds.md', content: '# Refunds\n\n## Rules\n\nA refund can be issued within 30 days of the charge.\n\n## API\n\n`POST /v1/refunds` with the charge id. The call is idempotent when you send an idempotency key.\n' } },
];

export function DatasetGuide({ existing, canEdit, onCreated }: { existing: string[]; canEdit: boolean; onCreated: (name: string) => void }) {
  const first = existing.length === 0;
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (s: Starter) => {
      await api('/v1/datasets', { method: 'POST', body: { name: s.name, trusted: true } });
      await api(`/v1/datasets/${encodeURIComponent(s.name)}/documents`, { method: 'POST', body: { documents: [s.doc] } });
      return s.name;
    },
    onSuccess: (name) => { void qc.invalidateQueries({ queryKey: ['datasets'] }); onCreated(name); },
  });
  return (
    <>
      <details className="panel ds-details" open={first}>
        <summary><b>What is a dataset, and what can I put in one?</b> <span className="muted small">{first ? '' : 'Show the guide'}</span></summary>
        <div className="ds-guide">
          <section>
            <h4>What it is</h4>
            <p>A set of documents your agents can search. When a step needs facts (your guidelines, a runbook, last quarter's decisions), a <code>retrieve</code> step or an agent looks them up and quotes the exact passage, instead of guessing or carrying everything in the prompt. That keeps prompts small and answers checkable.</p>
          </section>
          <section>
            <h4>Good things to put in</h4>
            <ul>
              <li>Team guidelines and style guides</li>
              <li>Runbooks and on-call notes</li>
              <li>Architecture decision records</li>
              <li>Incident postmortems</li>
              <li>API and product docs, FAQs</li>
              <li>Review checklists, onboarding notes</li>
            </ul>
          </section>
          <section>
            <h4>What it accepts today</h4>
            <p><b>Markdown (.md)</b> and <b>plain text (.txt)</b>. Documents are split at headings into passages of about 1,200 characters, so use clear headings.</p>
            <p className="muted small">Not supported yet: PDF, Word, HTML pages, spreadsheets, images, code repositories, or live sources such as Git, databases and MCP resources. Convert those to Markdown first.</p>
          </section>
          <section>
            <h4>How it works</h4>
            <ol>
              <li>Add documents.</li>
              <li><b>Publish a revision</b>. That indexes them (full text and vectors). A revision never changes.</li>
              <li>Steps read a pinned revision, such as <code>runbooks@approved</code>, and cite the passage and revision.</li>
            </ol>
          </section>
          <section>
            <h4>Trusted or untrusted?</h4>
            <p><b>Trusted</b>: only your team edits it. <b>Untrusted</b>: people outside can influence it (customer messages, scraped pages). An agent that reads an untrusted dataset is marked tainted, so any write after it needs a guard or an approval.</p>
          </section>
        </div>
      </details>
      {canEdit ? (
        <Panel title="Start from an example">
          <p className="muted small">Each creates a trusted dataset with one sample document that shows the shape. Replace it with your own, then publish.</p>
          <div className="ds-starters">
            {STARTERS.map((s) => (
              <article key={s.name} className="ds-starter">
                <h4>{s.title}</h4>
                <p>{s.why}</p>
                <p className="muted small mono">{s.name}</p>
                {existing.includes(s.name) ? <span className="muted small">You already have this one.</span> : <button type="button" disabled={create.isPending} onClick={() => create.mutate(s)}>Create it</button>}
              </article>
            ))}
          </div>
          <ErrorNote error={create.error} />
        </Panel>
      ) : null}
    </>
  );
}
