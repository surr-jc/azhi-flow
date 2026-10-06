import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../api';
import { Link, useRoute } from '../router';
import { Badge, ErrorNote, Loading, PageHead, Panel } from '../ui';
import { WorkflowCanvas, type PlanNode } from '../components/WorkflowCanvas';

/**
 * The workflow builder chat (src/builder/builder.ts): describe a requirement, answer the
 * builder's questions, and get a package the server has already compiled against this
 * workspace. Saving stores it as an unsigned draft and opens it in the editor; publishing
 * still needs a signature. The conversation stays in this browser tab.
 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
interface Message { role: 'user' | 'assistant'; content: Block[] }
interface Question { id: string; question: string; why?: string; options?: string[]; multiple?: boolean }
interface Proposal {
  tool_use_id: string;
  id: string;
  name?: string;
  summary: string;
  files: Record<string, string>;
  nodes: PlanNode[];
  warnings: Array<{ code: string; message: string; node?: string }>;
  missing: Array<{ kind: string; name: string; node: string }>;
  blockers: Array<{ code: string; message: string; node?: string }>;
  new_version_of?: string;
}
interface ProviderInfo { id: 'anthropic' | 'openai' | 'opencode'; label: string; ready: boolean; model?: string; reason?: string }
interface ModelList { provider: string; models: Array<{ id: string; label: string }>; recommended?: { id: string; reason: string }; source: 'live' | 'built-in'; note?: string }
interface Choice { provider?: string; model?: string }
interface Turn { messages: Message[]; event: { kind: string; proposal?: Proposal }; provider: string; model: string }
interface Saved { messages: Message[]; proposals: Record<string, Proposal>; shown?: string }

const KEY = 'azhi-builder';
const CHOICE_KEY = 'azhi-builder-model';
const OTHER = '__other__';

/** The provider and model last picked in this browser. */
function loadChoice(): Choice {
  try {
    return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function storeChoice(c: Choice) {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(c));
  } catch {
    /* remembered for this page only */
  }
}
const STARTERS = [
  'Every Monday, post a summary of last week’s failing CI runs to our team Slack channel.',
  'When I give it a GitHub issue, draft requirements and a design, and ask me to approve before anything is posted.',
  'Answer questions about our runbooks from a dataset, with citations.',
];
const LOOKUPS: Record<string, string> = {
  workspace_overview: 'Looked at this workspace’s tools, datasets, secrets and examples',
  get_tool: 'Read tool',
  read_example: 'Read example',
  read_workflow: 'Read workflow',
};

function load(): Saved {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (v && Array.isArray(v.messages)) return v;
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  return { messages: [], proposals: {} };
}
function store(s: Saved) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* the conversation lasts for this page only */
  }
}

export function WorkflowBuilder() {
  const status = useQuery({ queryKey: ['builder'], queryFn: () => api<{ providers: ProviderInfo[]; default?: string }>('/v1/builder') });
  const [state, setState] = useState<Saved>(load);
  const [choice, setChoiceState] = useState<Choice>(loadChoice);
  const setChoice = (c: Choice) => {
    setChoiceState(c);
    storeChoice(c);
  };
  const [draft, setDraft] = useState('');
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => store(state), [state]);

  const ready = status.data?.providers.filter((p) => p.ready) ?? [];
  // A remembered provider that is no longer set up falls back to the server's default.
  const using = ready.some((p) => p.id === choice.provider) ? choice.provider : status.data?.default;
  const model = choice.provider === using ? choice.model : undefined;
  const send = useMutation({
    mutationFn: (text: string) => api<Turn>('/v1/builder/chat', { method: 'POST', body: { messages: state.messages, text, provider: using, model } }),
    onSuccess: (r) => {
      setState((s) => {
        const proposals = { ...s.proposals };
        let shown = s.shown;
        if (r.event.kind === 'proposal' && r.event.proposal) {
          proposals[r.event.proposal.tool_use_id] = r.event.proposal;
          shown = r.event.proposal.tool_use_id;
        }
        return { messages: r.messages, proposals, shown };
      });
      setDraft('');
    },
  });
  // Keep the newest message in view inside the conversation, without scrolling the page.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [state.messages.length, send.isPending]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || send.isPending) return;
    send.mutate(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };
  const reset = () => {
    send.reset();
    setState({ messages: [], proposals: {} });
  };

  // The open question card is the last ask_user call, while nobody has answered it yet.
  const lastAsk = useMemo(() => {
    const m = state.messages;
    const lastAssistant = [...m].reverse().find((x) => x.role === 'assistant' && x.content.some((b) => b.type === 'tool_use' && b.name === 'ask_user'));
    if (!lastAssistant) return undefined;
    const i = m.indexOf(lastAssistant);
    const answered = m.slice(i + 1).some((x) => x.role === 'user' && x.content.some((b) => b.type === 'text'));
    return answered ? undefined : (lastAssistant.content.find((b) => b.type === 'tool_use' && b.name === 'ask_user') as Extract<Block, { type: 'tool_use' }>).id;
  }, [state.messages]);

  const shown = state.shown ? state.proposals[state.shown] : undefined;
  if (status.error) return <ErrorNote error={status.error} />;
  if (!status.data) return <Loading />;
  return (
    <>
      <PageHead
        title="Build a workflow with chat"
        sub="Describe what you need. The builder asks a few questions, drafts a workflow from this workspace’s tools, datasets and examples, and checks it with the compiler. Publishing still needs your signature."
        actions={
          <>
            {state.messages.length ? <button type="button" onClick={reset}>Start over</button> : null}
          </>
        }
      />
      {status.data.providers.length ? (
        <ModelPicker
          providers={status.data.providers}
          provider={using}
          model={model}
          serverDefault={status.data.providers.find((p) => p.id === using)?.model}
          onChange={setChoice}
        />
      ) : null}
      {!ready.length ? (
        <Panel>
          <p>The builder uses this workspace’s model provider, and none is set up yet.</p>
          <ul>{status.data.providers.map((p) => <li key={p.id}>{p.label}: {p.reason}</li>)}</ul>
          <p><Link to="/ui/secrets" className="button">Open secrets</Link></p>
        </Panel>
      ) : (
        <div className={`builder ${shown ? 'with-draft' : ''}`}>
          <section className="panel chat" aria-label="Conversation">
            <div className="chat-log" aria-live="polite" ref={log}>
              {!state.messages.length ? (
                <div className="chat-empty">
                  <p className="muted">What should the workflow do? A sentence or two is enough. For example:</p>
                  <div className="starters">
                    {STARTERS.map((s) => <button key={s} type="button" onClick={() => submit(s)} disabled={send.isPending}>{s}</button>)}
                  </div>
                </div>
              ) : null}
              {state.messages.map((m, i) => (
                <MessageView key={i} m={m} proposals={state.proposals} openAsk={lastAsk} busy={send.isPending} onAnswer={submit} onShow={(id) => setState((s) => ({ ...s, shown: id }))} shown={state.shown} />
              ))}
              {send.isPending ? <div className="bubble assistant pending"><span className="dots" aria-hidden="true" /> Working on it: reading the workspace, drafting and checking with the compiler…</div> : null}
              <ErrorNote error={send.error} />
            </div>
            <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(draft); }}>
              <textarea
                rows={2}
                aria-label="Message"
                placeholder={lastAsk ? 'Answer above, or type here…' : state.messages.length ? 'Ask for a change, or say “draft it”…' : 'Describe the workflow you need…'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
              />
              <button type="submit" className="primary" disabled={!draft.trim() || send.isPending}>Send</button>
            </form>
          </section>
          {shown ? <DraftPanel p={shown} onClose={() => setState((s) => ({ ...s, shown: undefined }))} /> : null}
        </div>
      )}
    </>
  );
}

function MessageView({ m, proposals, openAsk, busy, onAnswer, onShow, shown }: {
  m: Message;
  proposals: Record<string, Proposal>;
  openAsk?: string;
  busy: boolean;
  onAnswer: (text: string) => void;
  onShow: (id: string) => void;
  shown?: string;
}) {
  if (m.role === 'user') {
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
    return text ? <div className="bubble user">{text}</div> : null;
  }
  return (
    <>
      {m.content.map((b, i) => {
        if (b.type === 'text') return b.text.trim() ? <div key={i} className="bubble assistant">{b.text}</div> : null;
        if (b.type !== 'tool_use') return null;
        if (b.name === 'ask_user') return <Questions key={i} intro={b.input.intro} questions={b.input.questions ?? []} open={b.id === openAsk} busy={busy} onAnswer={onAnswer} />;
        if (b.name === 'propose_workflow') {
          const p = proposals[b.id];
          if (!p) return <div key={i} className="chat-note muted small">Drafted a version the compiler sent back; fixing it…</div>;
          return (
            <div key={i} className="draft-card">
              <div>
                <strong>{p.name ?? p.id}</strong> <Badge tone="ok">compiles</Badge>
                {p.missing.length ? <Badge tone="warn">{p.missing.length} to set up</Badge> : null}
                <div className="muted small">{p.nodes.length} step{p.nodes.length === 1 ? '' : 's'} · {Object.keys(p.files).length} files</div>
              </div>
              <button type="button" onClick={() => onShow(b.id)} disabled={shown === b.id}>{shown === b.id ? 'Shown' : 'View draft'}</button>
            </div>
          );
        }
        const label = LOOKUPS[b.name];
        const what = b.input.ref ?? b.input.id ?? b.input.slug;
        return label ? <div key={i} className="chat-note muted small">{label}{what ? <> <code>{String(what)}</code></> : null}</div> : null;
      })}
    </>
  );
}

/** One round of the builder's questions: options to pick, and a free answer for each. */
function Questions({ intro, questions, open, busy, onAnswer }: { intro?: string; questions: Question[]; open: boolean; busy: boolean; onAnswer: (text: string) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Question, o: string) =>
    setPicked((p) => {
      const cur = p[q.id] ?? [];
      return { ...p, [q.id]: q.multiple ? (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]) : cur[0] === o ? [] : [o] };
    });
  const answerOf = (q: Question) => [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id]!.trim()] : [])].join('; ');
  const answered = questions.filter((q) => answerOf(q));
  const send = () => onAnswer(questions.map((q) => `${q.question}\n→ ${answerOf(q) || '(no preference, use your recommendation)'}`).join('\n\n'));
  return (
    <div className={`questions ${open ? '' : 'closed'}`}>
      {intro ? <p className="q-intro">{intro}</p> : null}
      <ol>
        {questions.map((q) => (
          <li key={q.id}>
            <div className="q-text">{q.question}</div>
            {q.why ? <div className="muted small">{q.why}</div> : null}
            {open ? (
              <>
                {q.options?.length ? (
                  <div className="q-options" role={q.multiple ? 'group' : 'radiogroup'} aria-label={q.question}>
                    {q.options.map((o) => {
                      const on = (picked[q.id] ?? []).includes(o);
                      return <button key={o} type="button" className={`option ${on ? 'on' : ''}`} role={q.multiple ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => toggle(q, o)}>{o}</button>;
                    })}
                  </div>
                ) : null}
                <input type="text" aria-label={`Your answer: ${q.question}`} placeholder={q.options?.length ? 'Or write your own…' : 'Your answer…'} value={other[q.id] ?? ''} onChange={(e) => setOther((x) => ({ ...x, [q.id]: e.target.value }))} />
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {open ? (
        <div className="row">
          <button type="button" className="primary" disabled={busy || !answered.length} onClick={send}>Send answers</button>
          <button type="button" disabled={busy} onClick={() => onAnswer('Use your recommendations for anything open and draft it now.')}>Skip, just draft it</button>
          <span className="muted small">{answered.length} of {questions.length} answered</span>
        </div>
      ) : null}
    </div>
  );
}

function DraftPanel({ p, onClose }: { p: Proposal; onClose: () => void }) {
  const { navigate } = useRoute();
  const qc = useQueryClient();
  const paths = Object.keys(p.files).sort((a, b) => (a === 'workflow.yaml' ? -1 : b === 'workflow.yaml' ? 1 : a.localeCompare(b)));
  const [file, setFile] = useState<string>('workflow.yaml');
  const [tab, setTab] = useState<'graph' | 'files'>('graph');
  const save = useMutation({
    mutationFn: () => api<{ ok: boolean; errors?: string[]; version?: { id: string; workflow: string; version: number } }>('/v1/builder/save', { method: 'POST', body: { files: p.files, new_version_of: p.new_version_of } }),
    onSuccess: (r) => {
      if (!r.ok || !r.version) return;
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['versions', r.version.workflow] });
      navigate(`/ui/workflows/${encodeURIComponent(r.version.workflow)}/edit?from=${encodeURIComponent(r.version.id)}`);
    },
  });
  return (
    <section className="panel draft" aria-label="Draft workflow">
      <header className="panel-head">
        <h2>{p.name ?? p.id} <span className="muted small mono">{p.id}</span></h2>
        <button type="button" className="link small" onClick={onClose}>Hide</button>
      </header>
      {p.summary ? <p className="draft-summary">{p.summary}</p> : null}
      {p.missing.length || p.blockers.length ? (
        <div className="draft-todo">
          <strong>Before it can run</strong>
          <ul>
            {p.missing.map((m, i) => <li key={`m${i}`}>Set up {m.kind} <code>{m.name}</code> (used by {m.node})</li>)}
            {p.blockers.map((b, i) => <li key={`b${i}`}>{b.node ? `${b.node}: ` : ''}{b.message}</li>)}
          </ul>
        </div>
      ) : null}
      {p.warnings.length ? (
        <ul className="muted small draft-warnings">{p.warnings.map((w, i) => <li key={i}>{w.node ? `${w.node}: ` : ''}{w.message}</li>)}</ul>
      ) : null}
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'graph'} onClick={() => setTab('graph')}>Steps</button>
        <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>Files ({paths.length})</button>
      </div>
      {tab === 'graph' ? (
        <div className="draft-canvas"><WorkflowCanvas nodes={p.nodes} height={320} /></div>
      ) : (
        <>
          <div className="file-tabs">
            {paths.map((f) => <button key={f} type="button" className={`chip ${f === file ? 'on' : ''}`} onClick={() => setFile(f)}>{f}</button>)}
          </div>
          <pre className="code" aria-label={`Contents of ${file}`}>{p.files[file] ?? ''}</pre>
        </>
      )}
      <div className="row draft-actions">
        <button type="button" className="primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : p.new_version_of ? `Save as a new draft of ${p.new_version_of}` : 'Save draft and open the editor'}</button>
        <span className="muted small">Saved unsigned. Sign and publish from the workflow page when it is right.</span>
      </div>
      <ErrorNote error={save.error} />
      {save.data && !save.data.ok ? <div className="error" role="alert">Not saved: {save.data.errors?.join('; ')}</div> : null}
    </section>
  );
}

/**
 * Provider and model for the builder: every provider Azhi knows (those not usable here are shown
 * disabled, with why), the provider's own model list with one recommended for building
 * workflows, and "Other" for an id the list does not show. The choice is remembered.
 */
function ModelPicker({ providers, provider, model, serverDefault, onChange }: {
  providers: ProviderInfo[];
  provider?: string;
  model?: string;
  serverDefault?: string;
  onChange: (c: Choice) => void;
}) {
  const list = useQuery({
    queryKey: ['builder-models', provider],
    queryFn: () => api<ModelList>(`/v1/builder/models?provider=${encodeURIComponent(provider!)}`),
    enabled: Boolean(provider),
    staleTime: 5 * 60_000,
  });
  const models = list.data?.models ?? [];
  const recommended = list.data?.recommended;
  // No pick yet: the recommended model, else what the server would use.
  const current = model ?? recommended?.id ?? serverDefault;
  const listed = models.some((m) => m.id === current);
  const [typing, setTyping] = useState(false);
  const other = typing || (Boolean(current) && !listed && models.length > 0) || (!models.length && !list.isLoading);
  const [custom, setCustom] = useState('');
  useEffect(() => setCustom(current && !listed ? current : ''), [current, listed]);
  // The model's name, as the provider's own picker shows it; the id is the option's tooltip.
  const label = (m: { id: string; label: string }) => `${m.label}${m.id === recommended?.id ? ' · Recommended' : ''}`;
  const pickedReason = current === recommended?.id ? recommended?.reason : undefined;
  return (
    <div className="model-picker" aria-label="Model for the builder" role="group">
      <label>
        <span className="muted small">Provider</span>
        <select aria-label="Provider" value={provider ?? ''} onChange={(e) => { setTyping(false); onChange({ provider: e.target.value }); }}>
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.ready} title={p.reason}>
              {p.label}{p.ready ? '' : ' (not available)'}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted small">Model</span>
        <select
          aria-label="Model"
          value={other ? OTHER : (current ?? '')}
          disabled={!provider || list.isLoading}
          onChange={(e) => {
            if (e.target.value === OTHER) setTyping(true);
            else {
              setTyping(false);
              onChange({ provider, model: e.target.value });
            }
          }}
        >
          {list.isLoading ? <option value={current ?? ''}>Loading models…</option> : null}
          {models.map((m) => <option key={m.id} value={m.id} title={m.id}>{label(m)}</option>)}
          <option value={OTHER}>Other model id…</option>
        </select>
      </label>
      {other ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { onChange({ provider, model: custom.trim() }); setTyping(false); } }}>
          <input type="text" aria-label="Model id" placeholder="model id, for example gpt-5" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button type="submit" disabled={!custom.trim()}>Use</button>
        </form>
      ) : null}
      <div className="model-note muted small">
        {pickedReason ? <>Recommended for building workflows: {pickedReason}</> : recommended ? <>Recommended: {recommended.id}. {recommended.reason}</> : null}
        {list.data?.note ? <> {list.data.note}.</> : list.data?.source === 'built-in' ? ' Showing the built-in list.' : null}
        {providers.filter((p) => !p.ready).map((p) => <span key={p.id} className="block">{p.label} is not available: {p.reason}.</span>)}
      </div>
      <ErrorNote error={list.error} />
    </div>
  );
}
