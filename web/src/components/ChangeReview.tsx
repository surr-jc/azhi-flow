import { useState, type ReactNode } from 'react';
import { DiffView, looksLikeDiff } from './DiffView';
import { Formatted, Markdown } from './Rich';

interface Finding { id?: string; severity?: string; path?: string; line?: number; message?: string; reviewer?: string; confidence?: number }
interface Reviewer { reviewer: string; approved: boolean; summary?: string; critical?: number; major?: number; minor?: number; suggestion?: number }
interface Tests { status?: string; command?: string; exit_code?: number | null; attempts?: number; output?: string }
interface Payload {
  repository?: string;
  branch?: string;
  pr_title?: string;
  stats?: { files?: number; additions?: number; deletions?: number };
  diff?: string;
  tests?: Tests;
  review_path?: string;
  fix_rounds_used?: number;
  needs_human_attention?: boolean;
  verdict?: { approved?: boolean; findings?: Finding[]; reviewers?: Reviewer[]; dropped?: Record<string, unknown>[]; unverified?: Record<string, unknown>[]; prompt_injection_detected?: boolean };
  evidence?: Record<string, unknown> & { verification?: string; coverage?: Record<string, unknown> | null };
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** True for the release approval's payload: a change set with its reviewers' verdict. */
export function isChangeReview(p: unknown): p is Payload {
  return isRecord(p) && typeof p.diff === 'string' && looksLikeDiff(p.diff) && isRecord(p.verdict) && Array.isArray((p.verdict as { findings?: unknown }).findings);
}

const ORDER = ['critical', 'major', 'minor', 'suggestion'];
const SEVERITY_NOTE: Record<string, string> = {
  critical: 'Must be fixed before merging',
  major: 'Should be fixed before merging',
  minor: 'Worth fixing, not blocking',
  suggestion: 'Optional improvement',
};

/** A finding's message split into its bold headline (reviewers lead with one) and the rest. */
function splitMessage(message: string): { title: string; body: string } {
  const bold = /^\s*\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(message);
  if (bold) return { title: bold[1]!.trim(), body: bold[2]!.trim() };
  const sentence = /^(.{20,160}?[.!?])\s+([\s\S]*)$/.exec(message.trim());
  if (sentence) return { title: sentence[1]!, body: sentence[2]!.trim() };
  return { title: message.trim().length > 160 ? `${message.trim().slice(0, 157)}...` : message.trim(), body: message.trim().length > 160 ? message.trim() : '' };
}

/** Opens the file's card in the diff, scrolls to it and briefly marks the line. */
function showInDiff(path: string, line?: number) {
  const card = [...document.querySelectorAll<HTMLDetailsElement>('details.diff-file')].find((d) => d.dataset.path === path);
  if (!card) return;
  card.open = true;
  const row = line !== undefined ? card.querySelector<HTMLElement>(`tr[data-new="${line}"], tr[data-old="${line}"]`) : null;
  (row ?? card).scrollIntoView({ behavior: 'smooth', block: row ? 'center' : 'start' });
  const mark = row ?? card;
  mark.classList.add('flash');
  window.setTimeout(() => mark.classList.remove('flash'), 1800);
}

function FindingCard({ f }: { f: Finding }) {
  const sev = f.severity ?? 'minor';
  const { title, body } = splitMessage(f.message ?? '');
  return (
    <article className={`finding sev-${sev}`}>
      <header>
        <span className={`sev-badge ${sev}`}>{sev}</span>
        {f.id ? <code className="finding-id">{f.id}</code> : null}
        {f.confidence !== undefined ? <span className="muted small" title="How sure the independent verifier is that this is real">verified {f.confidence}%</span> : null}
        {f.reviewer ? <span className="muted small">by {f.reviewer} reviewer</span> : null}
      </header>
      <h4>{title}</h4>
      {f.path ? (
        <p className="finding-where">
          <code>{f.path}{f.line !== undefined ? `:${f.line}` : ''}</code>
          <button type="button" className="link small" onClick={() => showInDiff(f.path!, f.line)}>Show in the changes</button>
        </p>
      ) : null}
      {body ? <details className="finding-body" open={sev === 'critical' || sev === 'major' || body.length < 420}><summary className="small">Why it matters and what to do</summary><Markdown text={body} /></details> : null}
    </article>
  );
}

const Chip = ({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) => <span className={`chip ${tone}`}>{children}</span>;

/**
 * The release approval laid out for a decision: what happens and why it is a draft, then the findings
 * to weigh, then the change itself, then the test result and the evidence record.
 */
export function ChangeReview({ payload: p }: { payload: Payload }) {
  const [raw, setRaw] = useState(false);
  const findings = p.verdict?.findings ?? [];
  const reviewers = p.verdict?.reviewers ?? [];
  const dropped = p.verdict?.dropped ?? [];
  const unverified = p.verdict?.unverified ?? [];
  const tests = p.tests ?? {};
  const verification = p.evidence?.verification;
  const counts = Object.fromEntries(ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const blocking = (counts.critical ?? 0) + (counts.major ?? 0);
  const reasons: string[] = [];
  if (blocking) reasons.push(`${blocking} critical or major finding${blocking === 1 ? '' : 's'} from review`);
  if (verification === 'static') reasons.push('the tests could not run, so only typecheck and build verified it');
  if (verification === 'none') reasons.push('nothing could verify it: no tests and no build');
  if (p.verdict?.prompt_injection_detected) reasons.push('a reviewer saw a prompt injection attempt');
  if (tests.status && tests.status !== 'passed' && verification !== 'none') reasons.push(`the checks ${tests.status}`);
  const draft = Boolean(p.needs_human_attention) || (verification !== undefined && verification !== 'full');
  const testsTone = tests.status === 'passed' ? (verification === 'static' ? 'warn' : 'ok') : tests.status === 'failed' ? 'bad' : 'warn';
  const testsLabel = verification === 'static' ? 'Typecheck and build passed (no tests)' : verification === 'none' ? 'Not verified' : tests.status === 'passed' ? 'Tests passed' : `Tests ${tests.status ?? 'not run'}`;

  return (
    <div className="review">
      <section className={`review-verdict ${draft ? 'draft' : 'clean'}`} aria-label="Summary">
        <h3>{draft ? 'Opens as a draft pull request' : 'Opens as a pull request'}</h3>
        {p.pr_title ? <p className="review-title">{p.pr_title}</p> : null}
        {draft && reasons.length ? <ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
        <div className="chips">
          <Chip tone="info">{p.stats?.files ?? 0} files <span className="plus">+{p.stats?.additions ?? 0}</span> <span className="minus">-{p.stats?.deletions ?? 0}</span></Chip>
          <Chip tone={testsTone}>{testsLabel}</Chip>
          {reviewers.map((r) => (
            <Chip key={r.reviewer} tone={r.approved ? 'ok' : 'bad'}>{r.reviewer} reviewer: {r.approved ? 'approved' : 'asked for changes'}</Chip>
          ))}
          {p.fix_rounds_used !== undefined ? <Chip tone="info">{p.fix_rounds_used} fix round{p.fix_rounds_used === 1 ? '' : 's'}</Chip> : null}
        </div>
        <p className="muted small">To <code>{p.repository}</code> as branch <code>{p.branch}</code>.</p>
      </section>

      <section aria-label="Findings">
        <h3>Findings ({findings.length})</h3>
        {!findings.length ? <p className="muted">The reviewers reported nothing.</p> : (
          <>
            <p className="chips">{ORDER.filter((s) => counts[s]).map((s) => <span key={s} className={`sev-badge ${s}`} title={SEVERITY_NOTE[s]}>{counts[s]} {s}</span>)}</p>
            {ORDER.map((s) => findings.filter((f) => f.severity === s).map((f, i) => <FindingCard key={`${s}${f.id ?? i}`} f={f} />))}
          </>
        )}
        {reviewers.some((r) => r.summary) ? (
          <details className="review-more"><summary className="small">What the reviewers concluded</summary>
            {reviewers.filter((r) => r.summary).map((r) => <div key={r.reviewer}><strong>{r.reviewer} reviewer</strong><Markdown text={r.summary!} /></div>)}
          </details>
        ) : null}
        {unverified.length ? <details className="review-more"><summary className="small">{unverified.length} finding(s) the verifier could not settle</summary><Formatted value={unverified} /></details> : null}
        {dropped.length ? <details className="review-more"><summary className="small">{dropped.length} finding(s) the verifier refuted and dropped</summary><Formatted value={dropped} /></details> : null}
      </section>

      <section aria-label="Changes">
        <h3>The changes</h3>
        <DiffView text={p.diff ?? ''} />
      </section>

      <section aria-label="Tests">
        <h3>How it was checked</h3>
        <p><Chip tone={testsTone}>{testsLabel}</Chip> {tests.attempts !== undefined ? <span className="muted small">{tests.attempts} attempt{tests.attempts === 1 ? '' : 's'}, exit code {String(tests.exit_code ?? '—')}</span> : null}</p>
        {verification === 'static' && p.evidence?.coverage ? <Formatted value={p.evidence.coverage} /> : null}
        {tests.command ? <details className="review-more"><summary className="small">The command that ran</summary><pre className="json">{tests.command}</pre></details> : null}
      </section>

      <details className="review-more" aria-label="Evidence">
        <summary>Evidence record</summary>
        <p className="muted small">A digest of what was reviewed and tested; it is not a signature.</p>
        <Formatted value={p.evidence} rawLabel="the evidence as JSON" />
      </details>
      <p><button type="button" className="link small" onClick={() => setRaw((x) => !x)}>{raw ? 'Hide the full payload' : 'Show the full payload as JSON'}</button></p>
      {raw ? <pre className="json">{JSON.stringify({ ...p, diff: `(${(p.diff ?? '').length} characters, shown above)` }, null, 2)}</pre> : null}
    </div>
  );
}
