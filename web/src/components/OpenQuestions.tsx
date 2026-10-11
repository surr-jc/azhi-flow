import { useEffect, useMemo } from 'react';

export interface OpenQuestion {
  question: string;
  why?: string;
  options: { label: string; pros?: string; cons?: string }[];
  research?: string;
  counter_argument?: string;
  recommended_default?: string;
}

/** What the approver picked for one question: an option's label, or their own words. */
export interface QuestionChoice {
  mode: 'option' | 'other';
  option: number;
  other: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The questions in an approval payload, when it carries well-formed ones with options. */
export function readOpenQuestions(payload: unknown): OpenQuestion[] {
  const raw = (payload as { open_questions?: unknown } | null | undefined)?.open_questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is OpenQuestion =>
      Boolean(q) && typeof (q as OpenQuestion).question === 'string' && Array.isArray((q as OpenQuestion).options) && (q as OpenQuestion).options.length > 0,
  );
}

/** The option the workflow recommends: its label equals, or is contained in, the recommended default. */
export function recommendedIndex(q: OpenQuestion): number {
  const rec = norm(q.recommended_default ?? '');
  if (!rec) return -1;
  const exact = q.options.findIndex((o) => norm(o.label) === rec);
  if (exact >= 0) return exact;
  return q.options.findIndex((o) => {
    const l = norm(o.label);
    return l.length > 3 && (rec.includes(l) || l.includes(rec) || rec.startsWith(l.slice(0, Math.min(l.length, 40))));
  });
}

export const defaultChoices = (qs: OpenQuestion[]): QuestionChoice[] =>
  qs.map((q) => ({ mode: 'option', option: Math.max(0, recommendedIndex(q)), other: '' }));

/** The answers text the workflow receives: one numbered line per question, with the question quoted. */
export function composeAnswers(qs: OpenQuestion[], choices: QuestionChoice[]): string {
  return qs
    .map((q, i) => {
      const c = choices[i];
      const picked = c?.mode === 'other' ? c.other.trim() : q.options[c?.option ?? 0]?.label ?? '';
      const short = q.question.length > 160 ? `${q.question.slice(0, 157)}...` : q.question;
      return `${i + 1}) ${short} -> ${picked || '(no answer)'}`;
    })
    .join('\n');
}

export const choicesComplete = (qs: OpenQuestion[], choices: QuestionChoice[]) =>
  qs.every((_, i) => choices[i] && (choices[i].mode === 'option' || choices[i].other.trim().length > 0));

/**
 * One group of radio options per open question, the recommended one preselected, plus an "Other"
 * choice with a text box. The approver only changes what they disagree with.
 */
export function OpenQuestions({
  questions,
  choices,
  onChange,
  idPrefix,
}: {
  questions: OpenQuestion[];
  choices: QuestionChoice[];
  onChange: (c: QuestionChoice[]) => void;
  idPrefix: string;
}) {
  const initial = useMemo(() => defaultChoices(questions), [questions]);
  useEffect(() => {
    if (choices.length !== questions.length) onChange(initial);
  }, [choices.length, questions.length, initial, onChange]);

  const set = (i: number, patch: Partial<QuestionChoice>) =>
    onChange(questions.map((_, j) => (j === i ? { ...(choices[j] ?? initial[j]!), ...patch } : (choices[j] ?? initial[j]!))));

  return (
    <div className="open-questions">
      <h3 className="small">Open questions ({questions.length})</h3>
      <p className="muted small">The recommended answer is already selected. Change only the ones you disagree with.</p>
      <div className="row">
        <button type="button" onClick={() => onChange(initial)}>Use all recommended answers</button>
      </div>
      {questions.map((q, i) => {
        const c = choices[i] ?? initial[i]!;
        const rec = recommendedIndex(q);
        const name = `${idPrefix}-q${i}`;
        return (
          <fieldset key={name} className="oq">
            <legend>
              <span className="muted">{i + 1} of {questions.length}</span> {q.question}
            </legend>
            {q.why ? <p className="muted small">{q.why}</p> : null}
            {q.options.map((o, k) => (
              <label key={k} className={`oq-option${c.mode === 'option' && c.option === k ? ' picked' : ''}`}>
                <input type="radio" name={name} checked={c.mode === 'option' && c.option === k} onChange={() => set(i, { mode: 'option', option: k })} />
                <span>
                  <strong>{o.label}</strong>
                  {k === rec ? <span className="oq-rec"> recommended</span> : null}
                  {o.pros ? <span className="small oq-pros"> + {o.pros}</span> : null}
                  {o.cons ? <span className="small oq-cons"> - {o.cons}</span> : null}
                </span>
              </label>
            ))}
            <label className={`oq-option${c.mode === 'other' ? ' picked' : ''}`}>
              <input type="radio" name={name} checked={c.mode === 'other'} onChange={() => set(i, { mode: 'other' })} />
              <span>
                <strong>Other</strong>
                <input
                  type="text"
                  aria-label={`Your own answer to question ${i + 1}`}
                  value={c.other}
                  placeholder="Write your own answer"
                  onFocus={() => set(i, { mode: 'other' })}
                  onChange={(e) => set(i, { mode: 'other', other: e.target.value })}
                />
              </span>
            </label>
            {q.recommended_default ? <p className="small muted">Recommended: {q.recommended_default}</p> : null}
            {q.counter_argument ? <details className="small"><summary>Strongest counter-argument</summary><p>{q.counter_argument}</p></details> : null}
            {q.research ? <details className="small"><summary>Research</summary><p>{q.research}</p></details> : null}
          </fieldset>
        );
      })}
    </div>
  );
}
