import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Link, match, useRoute } from '../router';
import { ErrorNote } from '../ui';
import { HoldToConfirmButton } from './HoldToConfirmButton';
import { WorkingRow } from './WorkingRow';
import { loadChoice, ModelMenu, storeChoice, type Choice, type ProviderInfo } from './ModelMenu';
import { Markdown } from './Rich';

/**
 * The assistant (src/assistant): a bubble on every page that answers questions about this
 * workspace from its own state and docs, as the signed-in person. Actions it proposes run only
 * when the person confirms them here; building a workflow opens the workflow builder. The
 * conversation stays in this browser tab, like the builder's.
 * Surface: a non-modal panel docked bottom right, so the page stays usable beside it.
 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
interface Message { role: 'user' | 'assistant'; content: Block[] }
interface Proposal { tool_use_id: string; tool: string; args: Record<string, unknown>; title: string; detail?: string; danger?: boolean }
interface Handoff { prompt: string; workflow?: string }
type Event = { kind: 'text' } | { kind: 'action_proposal'; proposal: Proposal } | { kind: 'build_handoff'; handoff: Handoff };
interface Turn { messages: Message[]; event: Event }
/** What became of a proposed action: confirmed (with the result), or dismissed. */
interface Outcome { state: 'done' | 'dismissed'; result?: Record<string, unknown> }
interface Saved { messages: Message[]; proposals: Record<string, Proposal>; outcomes: Record<string, Outcome> }
interface PageContext { kind: 'run' | 'workflow' | 'dataset' | 'connection' | 'page'; id?: string; path: string }

const KEY = 'azhi-assistant';
const CHOICE_KEY = 'azhi-assistant-model';
const MAX_TEXT = 8000;
const EMPTY: Saved = { messages: [], proposals: {}, outcomes: {} };

function load(): Saved {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (v && Array.isArray(v.messages)) return { ...EMPTY, ...v };
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  return EMPTY;
}
function store(s: Saved) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* the conversation lasts for this page only */
  }
}

export function pageContext(path: string): PageContext {
  let m: Record<string, string> | null;
  if ((m = match('/ui/runs/:id', path))) return { kind: 'run', id: m.id, path };
  if ((m = match('/ui/workflows/:slug/edit', path) ?? match('/ui/workflows/:slug', path)) && !['new', 'upload'].includes(m.slug!)) return { kind: 'workflow', id: m.slug, path };
  if ((m = match('/ui/datasets/:name', path))) return { kind: 'dataset', id: m.name, path };
  if ((m = match('/ui/connections/:system', path))) return { kind: 'connection', id: m.system, path };
  return { kind: 'page', path };
}

function suggestions(page: PageContext): string[] {
  if (page.kind === 'run') return ['Why did this run fail?', 'What is this run waiting for?', 'What did this run cost?'];
  if (page.kind === 'workflow') return ['What does this workflow do?', 'Can I run it right now?', 'I want to change this workflow'];
  return ['What needs my attention today?', 'Which runs failed this week?', 'How much did we spend in the last 7 days?', 'Help me build a new workflow'];
}

const LOOKUP = (name: string) => name.replace(/_/g, ' ');
/** The notes `note()` adds when a card is confirmed or dismissed; anything else the person typed is their own words. */
const CARD_NOTE = /^\(I (confirmed|dismissed) ".*\)$/s;
const toHandoff = (input: Record<string, unknown>): Handoff | undefined =>
  typeof input.prompt === 'string' && input.prompt.trim() ? { prompt: input.prompt.trim(), ...(typeof input.workflow === 'string' ? { workflow: input.workflow } : {}) } : undefined;

export function Assistant() {
  const { path, navigate } = useRoute();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Saved>(load);
  const [draft, setDraft] = useState('');
  // The page goes with each message until the person removes it; a new page brings it back.
  const page = useMemo(() => pageContext(path), [path]);
  const [usePage, setUsePage] = useState(true);
  useEffect(() => setUsePage(true), [path]);
  useEffect(() => store(state), [state]);
  const fab = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const status = useQuery({ queryKey: ['assistant'], queryFn: () => api<{ providers: ProviderInfo[]; default?: string }>('/v1/assistant'), enabled: open, staleTime: 60_000 });
  const ready = status.data?.providers.some((p) => p.ready);
  // Provider (an API key, or OpenCode with a Copilot or ChatGPT sign-in) and model, remembered apart from the builder's.
  const [choice, setChoiceState] = useState<Choice>(() => loadChoice(CHOICE_KEY));
  const setChoice = (c: Choice) => {
    setChoiceState(c);
    storeChoice(CHOICE_KEY, c);
  };
  // A remembered provider that is no longer set up falls back to the server's default.
  const using = status.data?.providers.some((p) => p.ready && p.id === choice.provider) ? choice.provider : status.data?.default;
  const model = choice.provider === using ? choice.model : undefined;

  const abort = useRef<AbortController | null>(null);
  const send = useMutation({
    mutationFn: (text: string) => {
      abort.current = new AbortController();
      return api<Turn>('/v1/assistant/chat', { method: 'POST', body: { messages: state.messages, text, provider: using, model, ...(usePage ? { page } : {}) }, signal: abort.current.signal });
    },
    onSuccess: (r) => {
      setState((s) => ({
        ...s,
        messages: r.messages,
        proposals: r.event.kind === 'action_proposal' ? { ...s.proposals, [r.event.proposal.tool_use_id]: r.event.proposal } : s.proposals,
      }));
    },
    // A failed or stopped turn puts the typed message back, unless something new was typed meanwhile.
    onError: () => {
      const d = sent.current;
      if (d) setDraft((x) => x || d);
    },
  });
  // The composer clears on submit; this keeps what it held so a failed turn can restore it.
  const sent = useRef('');
  const submit = (text: string) => {
    const t = text.trim();
    if (!t || send.isPending) return;
    sent.current = text === draft ? draft : '';
    if (text === draft) setDraft('');
    send.mutate(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };

  // The model learns what the person did with a card in their next message, never by being told it ran when it did not.
  const note = (s: Saved, text: string): Message[] => {
    const messages = structuredClone(s.messages);
    const last = messages.at(-1);
    if (last?.role === 'user') last.content.push({ type: 'text', text });
    else messages.push({ role: 'user', content: [{ type: 'text', text }] });
    return messages;
  };
  const act = useMutation({
    mutationFn: (p: Proposal) => api<{ ok: true; result: Record<string, unknown> }>('/v1/assistant/actions', { method: 'POST', body: { tool: p.tool, args: p.args } }),
    onSuccess: (r, p) => {
      setState((s) => ({ ...s, messages: note(s, `(I confirmed "${p.title}". Result: ${JSON.stringify(r.result)})`), outcomes: { ...s.outcomes, [p.tool_use_id]: { state: 'done', result: r.result } } }));
      void qc.invalidateQueries();
    },
  });
  const dismiss = (p: Proposal) => setState((s) => ({ ...s, messages: note(s, `(I dismissed "${p.title}"; it did not run.)`), outcomes: { ...s.outcomes, [p.tool_use_id]: { state: 'dismissed' } } }));

  const close = () => {
    setOpen(false);
    fab.current?.focus();
  };
  // Ctrl+/ (⌘/ on a Mac) opens and closes the assistant from anywhere; Escape closes it.
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  useEffect(() => {
    if (open) composer.current?.focus();
  }, [open, ready]);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, send.isPending, open]);

  // The builder page is a chat of its own.
  if (path === '/ui/workflows/new') return null;
  const toBuilder = (h: Handoff) => {
    const prompt = h.workflow ? `Change the existing workflow ${h.workflow}: ${h.prompt}` : h.prompt;
    navigate(`/ui/workflows/new?prompt=${encodeURIComponent(prompt.slice(0, 500))}`);
  };
  const results = new Map<string, Extract<Block, { type: 'tool_result' }>>();
  for (const m of state.messages) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);

  return (
    <>
      {open ? (
        <section className="asst-panel" role="dialog" aria-label="Assistant" onKeyDown={(e) => {
          // Escape in the open model picker closes only the picker.
          if (e.key === 'Escape' && !e.currentTarget.querySelector('.model-pop')) close();
        }}>
          <header className="asst-head">
            <span className="asst-title"><Icon name="agent" size={16} />Assistant</span>
            <span className="asst-head-actions">
              {state.messages.length ? <button type="button" className="small-btn" onClick={() => { send.reset(); setState(EMPTY); }}>New chat</button> : null}
              <button type="button" className="icon-btn" aria-label="Close assistant" onClick={close}><Icon name="close" size={16} /></button>
            </span>
          </header>
          <div className="asst-log" ref={log} tabIndex={0} aria-label="Conversation messages">
            {status.error ? <ErrorNote error={status.error} /> : null}
            {status.data && !ready ? (
              <div className="asst-setup">
                <p>The assistant uses this workspace’s model provider, and none is set up yet.</p>
                <p className="muted small">{status.data.providers[0]?.reason}</p>
                <Link to="/ui/secrets" className="button" onClick={close}>Open secrets</Link>
              </div>
            ) : null}
            {!state.messages.length && ready ? (
              <div className="asst-empty">
                <p className="muted">Ask about your workflows, runs, approvals, spend or settings. Actions wait for you to confirm.</p>
                <div className="chips">{suggestions(page).map((s) => <button key={s} type="button" className="chip-btn" onClick={() => submit(s)} disabled={send.isPending}>{s}</button>)}</div>
              </div>
            ) : null}
            {state.messages.map((m, i) => (
              <MessageView
                key={i}
                m={m}
                results={results}
                proposals={state.proposals}
                outcomes={state.outcomes}
                busy={act.isPending || send.isPending}
                onConfirm={(p) => act.mutate(p)}
                onDismiss={dismiss}
                onBuild={toBuilder}
              />
            ))}
            <WorkingRow pending={send.isPending}>
              <span>Looking it up…</span>
              <button type="button" className="small-btn" onClick={() => abort.current?.abort()}>Stop</button>
            </WorkingRow>
            {send.error && (send.error as Error).name === 'AbortError' ? <div className="muted small">Stopped. Nothing was added; send it again to retry.</div> : <ErrorNote error={send.error} />}
            <ErrorNote error={act.error} />
            {state.messages.length > 160 ? <div className="muted small">This chat is getting long and will soon be refused; start a new chat for a new question.</div> : null}
            <div className="sr-only" role="status">{send.isPending ? 'The assistant is working' : send.isSuccess ? 'The assistant replied' : ''}</div>
          </div>
          <form className="asst-composer" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(draft); }}>
            {usePage && page.id ? (
              <span className="asst-context">
                About {page.kind} <code>{page.id}</code>
                <button type="button" className="icon-btn" aria-label={`Stop sending this ${page.kind} with messages`} onClick={() => setUsePage(false)}><Icon name="close" size={12} /></button>
              </span>
            ) : null}
            <div className="composer-box">
              <textarea ref={composer} rows={2} aria-label="Message" maxLength={MAX_TEXT} placeholder="Ask about this workspace…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} disabled={!ready} />
              <div className="composer-foot">
                {status.data && ready ? <ModelMenu providers={status.data.providers} provider={using} model={model} onChange={setChoice} modelsUrl="/v1/assistant/models" purpose="the assistant" /> : <span />}
                <button type="submit" className="primary composer-send" disabled={!draft.trim() || send.isPending || !ready} aria-busy={send.isPending}><Icon name="notify" size={14} />Send</button>
              </div>
            </div>
          </form>
        </section>
      ) : null}
      <button ref={fab} type="button" className={`asst-fab${open ? ' on' : ''}`} aria-label={open ? 'Close assistant' : 'Open assistant'} aria-expanded={open} title="Assistant (Ctrl+/)" onClick={() => (open ? close() : setOpen(true))}>
        <Icon name={open ? 'close' : 'chat'} size={22} />
      </button>
    </>
  );
}

function MessageView({ m, results, proposals, outcomes, busy, onConfirm, onDismiss, onBuild }: {
  m: Message;
  results: Map<string, Extract<Block, { type: 'tool_result' }>>;
  proposals: Record<string, Proposal>;
  outcomes: Record<string, Outcome>;
  busy: boolean;
  onConfirm: (p: Proposal) => void;
  onDismiss: (p: Proposal) => void;
  onBuild: (h: Handoff) => void;
}) {
  if (m.role === 'user') {
    // Tool results are the assistant's own lookups; only the person's words (and their notes on cards) show.
    const text = m.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text);
    return <>{text.map((t, i) => (CARD_NOTE.test(t) ? <div key={i} className="chat-note muted small">{t.slice(1, -1)}</div> : <div key={i} className="bubble user">{t}</div>))}</>;
  }
  const lookups = m.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use' && !proposals[b.id] && b.name !== 'open_builder');
  return (
    <div className="reply">
      {lookups.length ? (
        <div className="chat-note muted small">
          Looked up {lookups.map((b) => LOOKUP(b.name)).join(', ')}
          {lookups.some((b) => results.get(b.id)?.is_error) ? ' (some failed)' : ''}
        </div>
      ) : null}
      {m.content.map((b, i) => {
        if (b.type === 'text') return <Markdown key={i} text={b.text} className="bubble assistant" />;
        if (b.type === 'tool_use' && proposals[b.id]) return <ActionCard key={i} p={proposals[b.id]!} outcome={outcomes[b.id]} busy={busy} onConfirm={onConfirm} onDismiss={onDismiss} />;
        // The hand-off is the builder call itself, shown once the server accepted it (its result is not an error).
        const handoff = b.type === 'tool_use' && b.name === 'open_builder' && results.has(b.id) && !results.get(b.id)!.is_error ? toHandoff(b.input) : undefined;
        if (handoff) {
          return (
            <div key={i} className="asst-card">
              <strong>Build with the workflow builder</strong>
              <span className="small">{handoff.workflow ? <>Change <code>{handoff.workflow}</code>: </> : null}{handoff.prompt}</span>
              <div className="asst-actions"><button type="button" className="primary" onClick={() => onBuild(handoff)}><Icon name="flow" size={14} />Open the builder</button></div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function ActionCard({ p, outcome, busy, onConfirm, onDismiss }: { p: Proposal; outcome?: Outcome; busy: boolean; onConfirm: (p: Proposal) => void; onDismiss: (p: Proposal) => void }) {
  const runId = typeof outcome?.result?.run_id === 'string' ? outcome.result.run_id : undefined;
  return (
    <div className={`asst-card${p.danger ? ' danger' : ''}`}>
      <strong>{p.title}</strong>
      {p.detail ? <span className="small asst-detail">{p.detail}</span> : null}
      {outcome?.state === 'done' ? (
        <span className="small"><Icon name="check" size={14} /> Done{runId ? <> · <Link to={`/ui/runs/${runId}`}>open run {runId}</Link></> : null}</span>
      ) : outcome?.state === 'dismissed' ? (
        <span className="small muted">Dismissed; it did not run.</span>
      ) : (
        <div className="asst-actions">
          {p.danger ? (
            <HoldToConfirmButton className="danger" disabled={busy} onConfirm={() => onConfirm(p)}>Hold to confirm</HoldToConfirmButton>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => onConfirm(p)}>Confirm</button>
          )}
          <button type="button" disabled={busy} onClick={() => onDismiss(p)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
