import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, type WorkflowSummary } from '../api';
import { Link, useRoute } from '../router';
import { signVersion } from '../signing';
import { Badge, ErrorNote, Loading, PageHead, Panel } from '../ui';
import { Markdown } from '../components/Rich';
import { closeSignIn, McpStatusBadge, openSignInWindow, pointSignIn, useMcpConnection, type McpStatus } from '../components/McpSignIn';
import { WorkflowCanvas, type PlanNode } from '../components/WorkflowCanvas';

/**
 * The workflow builder chat (src/builder/builder.ts): describe a requirement, answer the
 * builder's questions, and get a package the server has already compiled against this
 * workspace. Saving stores it as an unsigned draft and opens it in the editor; publishing
 * still needs a signature. The conversation stays in this browser tab.
 * Page pattern: split pane. The conversation is the left pane; the compiled draft opens beside it.
 */
type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
interface Message { role: 'user' | 'assistant'; content: Block[] }
interface ToolProposal {
  tool_use_id: string;
  ref: string;
  summary: string;
  spec: Record<string, any>;
  credential?: { name: string; set: boolean };
  exists: boolean;
}
interface McpProposal {
  tool_use_id: string;
  slug: string;
  name: string;
  summary: string;
  scope: 'global' | 'project';
  workflow?: string;
  definition: Record<string, any>;
  needs: Array<{ name: string; secret: boolean }>;
  source?: string;
  marketplace_id?: string;
  runs_code: boolean;
}
interface McpConnectionProposal { tool_use_id: string; summary: string; name: string; url: string; auth_kind: 'none' | 'oauth' }
interface Question { id: string; question: string; why?: string; options?: string[]; multiple?: boolean }
interface Proposal {
  tool_use_id: string;
  id: string;
  name?: string;
  summary: string;
  files: Record<string, string>;
  /** `inputParts`: for a step that uses a shared context, where each input key came from. */
  nodes: Array<PlanNode & { inputParts?: Array<{ key: string; source: string }> }>;
  warnings: Array<{ code: string; message: string; node?: string }>;
  missing: Array<{ kind: string; name: string; node: string }>;
  blockers: Array<{ code: string; message: string; node?: string }>;
  new_version_of?: string;
}
interface ProviderInfo { id: 'anthropic' | 'openai' | 'opencode' | 'chatgpt'; label: string; ready: boolean; model?: string; reason?: string }
interface ModelList { provider: string; models: Array<{ id: string; label: string }>; recommended?: { id: string; reason: string }; source: 'live' | 'built-in'; note?: string }
interface Choice { provider?: string; model?: string }
/** Tokens the provider reported; null when it did not say (never estimated). */
interface Usage { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; reasoning_tokens: number | null }
interface Turn { messages: Message[]; event: { kind: string; proposal?: Proposal | ToolProposal | McpProposal | McpConnectionProposal }; provider: string; model: string; usage: Usage }
/** One answered turn: what it used and how long it took, kept by the index of its last message. */
interface TurnStat { usage: Usage; provider: string; model: string; ms: number }
interface Saved { messages: Message[]; proposals: Record<string, Proposal>; tools?: Record<string, ToolProposal>; mcps?: Record<string, McpProposal>; conns?: Record<string, McpConnectionProposal>; shown?: string; stats?: Record<number, TurnStat> }

const KEY = 'azhi-builder';
// The server refuses a longer conversation (src/api/builder.ts), so the size meter counts toward these.
const MAX_MESSAGES = 400;
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 20_000;
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const;

/** Sums a field over turns; null when no turn reported it. */
function total(stats: TurnStat[], f: keyof Usage): number | null {
  const v = stats.map((s) => s.usage[f]).filter((n): n is number => typeof n === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}
const compact = (n: number | null) => (n === null ? '—' : n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const exact = (n: number | null) => (n === null ? 'not reported' : n.toLocaleString());
const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
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
  workspace_overview: 'Looked at this workspace’s tools, MCP servers, skills, datasets, secrets and examples',
  find_integrations: 'Searched the marketplaces for',
  get_tool: 'Read tool',
  read_example: 'Read example',
  read_workflow: 'Read workflow',
  read_workflow_file: 'Read workflow file',
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
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => store(state), [state]);

  const ready = status.data?.providers.filter((p) => p.ready) ?? [];
  // A remembered provider that is no longer set up falls back to the server's default.
  const using = ready.some((p) => p.id === choice.provider) ? choice.provider : status.data?.default;
  const model = choice.provider === using ? choice.model : undefined;
  // Stop only ends the wait in this tab; the server may still finish the turn, and nothing is added to the conversation.
  const abort = useRef<AbortController | null>(null);
  const send = useMutation({
    mutationFn: async (text: string) => {
      const t0 = performance.now();
      abort.current = new AbortController();
      const r = await api<Turn>('/v1/builder/chat', { method: 'POST', body: { messages: state.messages, text, provider: using, model }, signal: abort.current.signal });
      return { r, ms: Math.round(performance.now() - t0) };
    },
    onSuccess: ({ r, ms }) => {
      setState((s) => {
        const stats = { ...s.stats, [r.messages.length - 1]: { usage: r.usage, provider: r.provider, model: r.model, ms } };
        const proposals = { ...s.proposals };
        const tools = { ...s.tools };
        const mcps = { ...s.mcps };
        const conns = { ...s.conns };
        let shown = s.shown;
        if (r.event.kind === 'proposal' && r.event.proposal) {
          proposals[r.event.proposal.tool_use_id] = r.event.proposal as Proposal;
          shown = r.event.proposal.tool_use_id;
        }
        if (r.event.kind === 'tool_proposal' && r.event.proposal) tools[r.event.proposal.tool_use_id] = r.event.proposal as ToolProposal;
        if (r.event.kind === 'mcp_proposal' && r.event.proposal) mcps[r.event.proposal.tool_use_id] = r.event.proposal as McpProposal;
        if (r.event.kind === 'mcp_connection_proposal' && r.event.proposal) conns[r.event.proposal.tool_use_id] = r.event.proposal as McpConnectionProposal;
        return { messages: r.messages, proposals, tools, mcps, conns, shown, stats };
      });
      setDraft('');
    },
  });
  // Follow the newest message only while the reader is at the bottom; otherwise offer a jump so reading is not interrupted.
  const [away, setAway] = useState(false);
  const toBottom = () => {
    const el = log.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setAway(false);
  };
  const onScroll = () => {
    const el = log.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 48) setAway(false);
  };
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) toBottom();
    else setAway(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages.length, send.isPending]);

  const existing = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowSummary[]>('/v1/workflows/summary') });
  const [editSlug, setEditSlug] = useState('');
  const [editVersion, setEditVersion] = useState('');
  const editVersions = useQuery({
    queryKey: ['versions', editSlug],
    queryFn: () => api<Array<{ id: string; version: number; draft: boolean; signed: boolean }>>(`/v1/workflows/${encodeURIComponent(editSlug)}/versions`),
    enabled: Boolean(editSlug),
  });
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
  const [confirmReset, setConfirmReset] = useState(false);
  const reset = () => {
    send.reset();
    setConfirmReset(false);
    setState({ messages: [], proposals: {}, stats: {} });
  };
  const turns = useMemo(() => Object.values(state.stats ?? {}), [state.stats]);
  const bytes = useMemo(() => JSON.stringify(state.messages).length, [state.messages]);
  // Seconds the current turn has been running, so a long draft is visibly alive.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!send.isPending) return setWaited(0);
    const t0 = Date.now();
    const id = window.setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [send.isPending]);

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
  const latest = Object.values(state.proposals).at(-1);
  if (status.error) return <ErrorNote error={status.error} />;
  if (!status.data) return <Loading />;
  return (
    <>
      <PageHead
        title="Build a workflow with chat"
        sub="The builder asks a few questions, drafts a workflow and checks it with the compiler. Publishing still needs your signature."
        actions={
          state.messages.length ? (
            confirmReset ? (
              <span className="row" role="group" aria-label="Confirm start over">
                <span className="small">Discard this conversation and its drafts?</span>
                <button type="button" className="danger" onClick={reset}>Discard conversation</button>
                <button type="button" onClick={() => setConfirmReset(false)}>Keep it</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmReset(true)}>Start over</button>
            )
          ) : undefined
        }
      />
      {status.data.providers.length ? (
        <details className="model-fold">
          <summary>Model: {status.data.providers.find((p) => p.id === using)?.label ?? 'none'} · {model ?? status.data.providers.find((p) => p.id === using)?.model ?? 'default'}</summary>
          <ModelPicker
            providers={status.data.providers}
            provider={using}
            model={model}
            serverDefault={status.data.providers.find((p) => p.id === using)?.model}
            onChange={setChoice}
          />
        </details>
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
            {state.messages.length || send.isPending ? <UsageBar turns={turns} provider={using} model={model ?? status.data.providers.find((p) => p.id === using)?.model} messages={state.messages.length} bytes={bytes} pending={send.isPending} /> : null}
            <div className="sr-only" role="status">{send.isPending ? 'The builder is working' : send.isSuccess ? 'The builder replied' : ''}</div>
            <div className="chat-log" ref={log} onScroll={onScroll} tabIndex={0} aria-label="Conversation messages">
              {!state.messages.length ? (
                <div className="chat-empty">
                  <p className="muted">What should the workflow do? A sentence or two is enough. Pick an example to edit, or write your own below.</p>
                  <div className="starters">
                    {STARTERS.map((s) => <button key={s} type="button" onClick={() => { setDraft(s); composer.current?.focus(); }} disabled={send.isPending}>{s}</button>)}
                  </div>
                  {existing.data?.length ? (
                    <div className="edit-existing">
                      <label htmlFor="edit-existing">Or change an existing workflow</label>
                      <div className="row">
                        <select id="edit-existing" value={editSlug} onChange={(e) => { setEditSlug(e.target.value); setEditVersion(''); }}>
                          <option value="">Choose a workflow…</option>
                          {existing.data.map((w) => <option key={w.slug} value={w.slug}>{w.latest?.name ? `${w.latest.name} (${w.slug})` : w.slug}</option>)}
                        </select>
                        <select aria-label="Version to start from" value={editVersion} disabled={!editSlug} onChange={(e) => setEditVersion(e.target.value)}>
                          <option value="">Latest version</option>
                          {(editVersions.data ?? []).map((v) => <option key={v.id} value={v.version}>{`v${v.version}${v.draft ? ' (draft)' : v.signed ? ' (signed)' : ''}`}</option>)}
                        </select>
                        <button type="button" disabled={!editSlug || send.isPending} onClick={() => submit(`I want to change the existing workflow ${editSlug}${editVersion ? `, starting from version ${editVersion}` : ' (its latest version)'}. Read it first${editVersion ? ` with version ${editVersion}` : ''}, then ask me what to change.`)}>Edit workflow</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {state.messages.map((m, i) => (
                <MessageView key={i} m={m} proposals={state.proposals} tools={state.tools ?? {}} mcps={state.mcps ?? {}} conns={state.conns ?? {}} openAsk={lastAsk} busy={send.isPending} onAnswer={submit} onShow={(id) => setState((s) => ({ ...s, shown: id }))} shown={state.shown} stat={state.stats?.[i]} />
              ))}
              {send.isPending ? (
                <div className="pending">
                  <span className="dots" aria-hidden="true" />
                  <span>Reading the workspace, drafting and checking with the compiler…</span>
                  <span className="mono">{waited}s</span>
                  <button type="button" className="small-btn" title="Stops waiting in this tab. The server may still finish the turn." onClick={() => abort.current?.abort()}>Stop</button>
                </div>
              ) : null}
              {send.error && (send.error as Error).name === 'AbortError' ? <div className="chat-note muted small">Stopped. Nothing was added to the conversation; send it again to retry.</div> : <ErrorNote error={send.error} />}
            </div>
            {away ? <button type="button" className="jump" onClick={toBottom}>New message ↓</button> : null}
            {latest && state.shown !== latest.tool_use_id ? (
              <div className="draft-bar">
                <span><strong>{latest.name ?? latest.id}</strong> <Badge tone={latest.blockers.length ? 'bad' : 'ok'}>{latest.blockers.length ? 'blocked' : 'compiles'}</Badge> <span className="muted small">{latest.nodes.length} step{latest.nodes.length === 1 ? '' : 's'}</span></span>
                <button type="button" onClick={() => setState((s) => ({ ...s, shown: latest.tool_use_id }))}>View draft</button>
              </div>
            ) : null}
            <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(draft); }}>
              {state.messages.length > 1 && !send.isPending ? (
                <div className="chips">
                  <button type="button" className="chip-btn" onClick={() => submit('Use your recommendations for anything open and draft it now.')}>Draft it</button>
                  {latest ? <button type="button" className="chip-btn" onClick={() => submit('Explain what this draft does and what I still need to set up.')}>Explain the draft</button> : null}
                </div>
              ) : null}
              <div className="composer-row">
                <textarea
                  ref={composer}
                  rows={2}
                  aria-label="Message"
                  aria-describedby="composer-meta"
                  maxLength={MAX_TEXT}
                  placeholder={lastAsk ? 'Answer above, or type here…' : state.messages.length ? 'Ask for a change, or say “draft it”…' : 'Describe the workflow you need…'}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                />
                <button type="submit" className="primary" disabled={!draft.trim() || send.isPending} aria-busy={send.isPending}>Send</button>
              </div>
              <div id="composer-meta" className="composer-meta muted">
                <span><kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line</span>
                {draft.length > MAX_TEXT * 0.8 ? <span className={draft.length >= MAX_TEXT ? 'bad-text' : ''}>{draft.length.toLocaleString()} / {MAX_TEXT.toLocaleString()}</span> : null}
              </div>
            </form>
          </section>
          {shown ? <DraftPanel p={shown} onClose={() => setState((s) => ({ ...s, shown: undefined }))} /> : null}
        </div>
      )}
    </>
  );
}

/**
 * Session meter above the conversation: tokens the provider reported for every turn so far, the
 * last turn, and how close the conversation is to the size the server accepts. Input counts every
 * lookup round of a turn (each re-sends the context), so it grows faster than the text you see.
 * Cost is not shown: the builder has no price list, and an unknown value is never guessed.
 */
function UsageBar({ turns, provider, model, messages, bytes, pending }: { turns: TurnStat[]; provider?: string; model?: string; messages: number; bytes: number; pending: boolean }) {
  const last = turns[turns.length - 1];
  const sum = (f: keyof Usage) => total(turns, f);
  const all = USAGE_FIELDS.map((f) => sum(f));
  const grand = all.every((n) => n === null) ? null : (sum('input_tokens') ?? 0) + (sum('output_tokens') ?? 0);
  const lastTokens = last ? (last.usage.input_tokens ?? 0) + (last.usage.output_tokens ?? 0) : null;
  const fill = Math.max(messages / MAX_MESSAGES, bytes / MAX_BYTES);
  const full = fill >= 0.8;
  const cells: Array<{ label: string; value: number | null; hint: string }> = [
    { label: 'Input', value: sum('input_tokens'), hint: 'Tokens sent to the model across all turns, including each lookup round' },
    { label: 'Output', value: sum('output_tokens'), hint: 'Tokens the model wrote across all turns' },
    { label: 'Cached', value: sum('cache_read_tokens'), hint: 'Input tokens served from the provider’s prompt cache' },
  ];
  return (
    <details className="usage" aria-label="Session usage">
      <summary>
        <span><strong>{compact(grand)}</strong> tokens · {turns.length ? `${turns.length} turn${turns.length === 1 ? '' : 's'}` : pending ? 'first turn running' : 'no turns yet'}</span>
        <span className={full ? 'warn-text' : 'muted'}>{messages ? `${Math.max(1, Math.round(fill * 100))}% full` : 'empty'}{full ? ' · start over soon' : ''}</span>
      </summary>
      <div className="usage-main">
        <div className="usage-total">
          <span className="usage-label">Session tokens</span>
          <strong className="usage-value" title={exact(grand)}>{compact(grand)}</strong>
          <span className="muted small">{turns.length ? `${turns.length} turn${turns.length === 1 ? '' : 's'}` : pending ? 'first turn running' : 'no turns yet'}</span>
        </div>
        <dl className="usage-cells">
          {cells.map((c) => (
            <div key={c.label} title={`${c.hint}. ${exact(c.value)}`}>
              <dt>{c.label}</dt>
              <dd>{compact(c.value)}</dd>
            </div>
          ))}
          <div title="Cost is not estimated: the builder has no price list for this model">
            <dt>Cost</dt>
            <dd className="muted">unavailable</dd>
          </div>
        </dl>
      </div>
      <div className="usage-foot muted small">
        <span className="mono" title="Provider and model used for the next turn">{provider ?? '—'}{model ? ` · ${model}` : ''}</span>
        {last ? <span title={`Input ${exact(last.usage.input_tokens)}, output ${exact(last.usage.output_tokens)}`}>Last turn {compact(lastTokens)} tokens · {seconds(last.ms)}</span> : null}
        <span className={full ? 'warn-text' : ''} title={`${messages} of ${MAX_MESSAGES} messages; ${(bytes / 1000).toFixed(0)} KB of ${(MAX_BYTES / 1000).toFixed(0)} KB`}>
          Conversation {messages ? `${Math.max(1, Math.round(fill * 100))}% full` : 'empty'}
          {full ? ' · start over soon' : ''}
        </span>
      </div>
    </details>
  );
}

/** Compact per-turn line under the builder's reply. */
function TurnMeta({ s }: { s: TurnStat }) {
  const cached = s.usage.cache_read_tokens;
  return (
    <div className="turn-meta muted" title={`Input ${exact(s.usage.input_tokens)}, output ${exact(s.usage.output_tokens)}, cached ${exact(cached)}`}>
      {compact(s.usage.input_tokens)} in · {compact(s.usage.output_tokens)} out{cached ? ` · ${compact(cached)} cached` : ''} · {seconds(s.ms)} · <span className="mono">{s.model}</span>
    </div>
  );
}

function MessageView({ m, proposals, tools, mcps, conns, openAsk, busy, onAnswer, onShow, shown, stat }: {
  m: Message;
  stat?: TurnStat;
  proposals: Record<string, Proposal>;
  tools: Record<string, ToolProposal>;
  mcps: Record<string, McpProposal>;
  conns: Record<string, McpConnectionProposal>;
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
  // Consecutive lookup notes collapse into one line so a long turn reads as its replies, not its tool calls.
  const items: Array<{ note: boolean; node: ReactNode }> = [];
  const push = (note: boolean, node: ReactNode) => items.push({ note, node });
  const grouped = () => {
    const out: ReactNode[] = [];
    for (let i = 0; i < items.length; ) {
      if (!items[i]!.note) { out.push(items[i]!.node); i++; continue; }
      let j = i;
      while (j < items.length && items[j]!.note) j++;
      const run = items.slice(i, j);
      out.push(run.length === 1 ? run[0]!.node : (
        <details key={`l${i}`} className="lookups">
          <summary>Looked at {run.length} things</summary>
          {run.map((r) => r.node)}
        </details>
      ));
      i = j;
    }
    return out;
  };
  m.content.forEach((b, i) => {
        if (b.type === 'text') return void (b.text.trim() ? push(false, <div key={i} className="reply"><Markdown className="bubble assistant" text={b.text} /><CopyButton text={b.text} /></div>) : null);
        if (b.type !== 'tool_use') return;
        if (b.name === 'ask_user') return void push(false, <Questions key={i} intro={b.input.intro} questions={b.input.questions ?? []} open={b.id === openAsk} busy={busy} onAnswer={onAnswer} />);
        if (b.name === 'propose_tool') {
          const t = tools[b.id];
          return void (t ? push(false, <ToolCard key={i} t={t} />) : push(true, <div key={i} className="chat-note muted small">Drafted a tool spec the server sent back; fixing it…</div>));
        }
        if (b.name === 'propose_mcp_server') {
          const t = mcps[b.id];
          return void (t ? push(false, <McpCard key={i} t={t} busy={busy} onAnswer={onAnswer} />) : push(true, <div key={i} className="chat-note muted small">Drafted an MCP server the server sent back; fixing it…</div>));
        }
        if (b.name === 'propose_mcp_connection') {
          const t = conns[b.id];
          return void (t ? push(false, <McpConnectionCard key={i} t={t} busy={busy} onAnswer={onAnswer} />) : push(true, <div key={i} className="chat-note muted small">Drafted an MCP connection the server sent back; fixing it…</div>));
        }
        if (b.name === 'propose_workflow') {
          const p = proposals[b.id];
          if (!p) return void push(true, <div key={i} className="chat-note muted small">Drafted a version the compiler sent back; fixing it…</div>);
          return void push(false, (
            <div key={i} className="draft-card">
              <div>
                <strong>{p.name ?? p.id}</strong> <Badge tone="ok">compiles</Badge>
                {p.missing.length ? <Badge tone="warn">{p.missing.length} to set up</Badge> : null}
                <div className="muted small">{p.nodes.length} step{p.nodes.length === 1 ? '' : 's'} · {Object.keys(p.files).length} files</div>
              </div>
              <button type="button" onClick={() => onShow(b.id)} disabled={shown === b.id}>{shown === b.id ? 'Shown' : 'View draft'}</button>
            </div>
          ));
        }
        const label = LOOKUPS[b.name];
        const what = b.input.ref ?? b.input.id ?? b.input.slug;
        if (label) push(true, <div key={i} className="chat-note muted small">{label}{what ? <> <code>{String(what)}</code></> : null}</div>);
  });
  return (
    <>
      {grouped()}
      {stat ? <TurnMeta s={stat} /> : null}
    </>
  );
}

/** Copies one reply; says so for a moment, and says nothing when the clipboard is blocked. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="small-btn copy"
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1500); }, () => undefined)}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A tool the builder proposes: an admin confirms to register it (a new revision when it exists). */
function ToolCard({ t }: { t: ToolProposal }) {
  const qc = useQueryClient();
  const reg = useMutation({
    mutationFn: () => api<{ ref: string; revision: number; changed: boolean }>('/v1/builder/register-tool', { method: 'POST', body: { tool: t.spec } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tools'] }),
  });
  const tr = t.spec.transport ?? {};
  return (
    <div className="draft-card">
      <div>
        <strong className="mono">{t.ref}</strong> <Badge tone="ok">{t.spec.effect}</Badge> {t.exists ? <Badge tone="warn">new revision</Badge> : null}
        <div className="muted small">{tr.kind === 'mcp-stdio' ? `MCP: ${(tr.command ?? []).join(' ')} → ${tr.tool}` : `${tr.method} ${tr.url}`}</div>
        {t.credential ? <div className="muted small">Secret <code>{t.credential.name}</code>: {t.credential.set ? 'set' : 'not set yet (Secrets page)'}</div> : null}
        {reg.data ? <div className="ok-note" role="status">{reg.data.changed ? `Registered revision ${reg.data.revision}.` : `Already registered (revision ${reg.data.revision}).`}</div> : null}
        {reg.error ? <ErrorNote error={reg.error} /> : null}
      </div>
      <button type="button" className="primary" disabled={reg.isPending || Boolean(reg.data)} onClick={() => reg.mutate()}>{reg.data ? 'Registered' : 'Register tool'}</button>
    </div>
  );
}

/** An MCP server the builder proposes, like `opencode mcp add`: confirming adds it to the library, then offers to use it in the workflow. */
function McpCard({ t, busy, onAnswer }: { t: McpProposal; busy: boolean; onAnswer: (text: string) => void }) {
  const qc = useQueryClient();
  const add = useMutation({
    // A server fetched from a marketplace is sent by id, so the server fetches the definition again.
    mutationFn: () => api<{ slug: string; status: string }>('/v1/builder/register-mcp', { method: 'POST', body: { server: { slug: t.slug, name: t.name, description: '', scope: t.scope, ...(t.workflow ? { workflow: t.workflow } : {}), ...(t.marketplace_id ? { marketplace_id: t.marketplace_id } : { definition: t.definition }) } } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portable-assets'] }),
  });
  const d = t.definition;
  return (
    <div className="draft-card">
      <div>
        <strong className="mono">{t.slug}</strong> <Badge tone="ok">{t.scope === 'project' ? `project · ${t.workflow}` : 'global'}</Badge> {t.runs_code ? <Badge tone="warn">runs on a worker</Badge> : null}
        <div className="muted small">{d.transport === 'remote' ? `Hosted: ${d.url}` : `Runs: ${(d.command ?? []).join(' ')}`}{t.source ? ` · from ${t.source}` : ''}</div>
        {t.needs.length ? <div className="muted small">Set <code>{t.needs.map((n) => n.name).join(', ')}</code> where the harness runs. Values are never stored in Azhi.</div> : null}
        {add.data ? <div className="ok-note" role="status">Added to the library ({add.data.status}).</div> : null}
        {add.error ? <ErrorNote error={add.error} /> : null}
      </div>
      {add.data
        ? <button type="button" className="primary" disabled={busy} onClick={() => onAnswer(`I added the MCP server ${t.slug}. Use it in the workflow.`)}>Use in this workflow</button>
        : <button type="button" className="primary" disabled={add.isPending} onClick={() => add.mutate()}>{t.runs_code ? 'Add (admin)' : 'Add MCP server'}</button>}
    </div>
  );
}

/** A hosted MCP server the builder proposes to connect to the gateway: an admin's click creates it and opens sign-in. */
function McpConnectionCard({ t, busy, onAnswer }: { t: McpConnectionProposal; busy: boolean; onAnswer: (text: string) => void }) {
  const qc = useQueryClient();
  const win = useRef<Window | null>(null);
  const [link, setLink] = useState<string>();
  const create = useMutation({
    mutationFn: () => api<McpStatus & { authorization_url?: string }>('/v1/mcp/connections', { method: 'POST', body: { name: t.name, url: t.url, auth_kind: t.auth_kind } }),
    onSuccess: (r) => {
      if (r.authorization_url && !pointSignIn(win.current, r.authorization_url)) setLink(r.authorization_url);
      void qc.invalidateQueries({ queryKey: ['mcp-connections'] });
    },
    onError: () => closeSignIn(win.current),
  });
  const live = useMcpConnection(create.data?.id);
  const now = live.data ?? create.data;
  return (
    <div className="draft-card">
      <div>
        <strong className="mono">{t.name}</strong> <Badge tone="ok">{t.auth_kind === 'oauth' ? 'OAuth' : 'no sign-in'}</Badge> {now ? <McpStatusBadge c={now} /> : null}
        <div className="muted small">{t.url}</div>
        {now?.status === 'authorizing' ? <div className="muted small">Approve access in the sign-in window.{link ? <> Did not open? <a href={link} target="_blank" rel="noreferrer">Continue sign-in</a>.</> : null}</div> : null}
        {now?.status === 'ready' ? <div className="ok-note" role="status">Connected. <Link to="/ui/tools">Discover its tools on the Tools page</Link> to use them in a workflow.</div> : null}
        {now && (now.status === 'error' || now.status === 'disconnected') ? <div className="error">{now.last_error ?? 'Sign-in did not finish.'} Reconnect it from the Connections page.</div> : null}
        <ErrorNote error={create.error} />
      </div>
      {now?.status === 'ready'
        ? <button type="button" className="primary" disabled={busy} onClick={() => onAnswer(`I connected the MCP server ${t.name} to the gateway. Continue.`)}>Continue</button>
        : <button type="button" className="primary" disabled={create.isPending || Boolean(create.data)} onClick={() => { win.current = t.auth_kind === 'oauth' ? openSignInWindow() : null; create.mutate(); }}>{t.auth_kind === 'oauth' ? 'Connect and sign in (admin)' : 'Connect (admin)'}</button>}
    </div>
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
  const Root = open ? 'div' : 'details';
  return (
    <Root className={`questions ${open ? '' : 'closed'}`}>
      {open ? null : <summary>The builder asked {questions.length} question{questions.length === 1 ? '' : 's'}</summary>}
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
          <button type="button" className="link" disabled={busy} onClick={() => onAnswer('Use your recommendations for anything open and draft it now.')}>Skip, just draft it</button>
          <span className="muted small">{answered.length} of {questions.length} answered</span>
        </div>
      ) : null}
    </Root>
  );
}

function DraftPanel({ p, onClose }: { p: Proposal; onClose: () => void }) {
  const { navigate } = useRoute();
  const qc = useQueryClient();
  const paths = Object.keys(p.files).sort((a, b) => (a === 'workflow.yaml' ? -1 : b === 'workflow.yaml' ? 1 : a.localeCompare(b)));
  const [file, setFile] = useState<string>('workflow.yaml');
  const [tab, setTab] = useState<'graph' | 'files'>('graph');
  // Which steps take keys from a shared context, from what the compiler recorded for each.
  const shared = p.nodes.flatMap((n) => (n.inputParts ?? []).filter((x) => x.source.startsWith('context:')).map((x) => ({ node: n.id, bundle: x.source.slice('context:'.length), key: x.key })));
  const save = useMutation({
    mutationFn: async () => {
      const r = await api<{ ok: boolean; errors?: string[]; version?: { id: string; workflow: string; version: number } }>('/v1/builder/save', { method: 'POST', body: { files: p.files, new_version_of: p.new_version_of } });
      // Workers run signed packages only; the workflow page offers signing again if this fails.
      if (r.ok && r.version) await signVersion(r.version.id).catch(() => undefined);
      return r;
    },
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
      <dl className="draft-facts">
        <div><dt>Status</dt><dd><Badge tone={p.blockers.length ? 'bad' : 'ok'}>{p.blockers.length ? 'blocked' : 'compiles'}</Badge></dd></div>
        <div><dt>Steps</dt><dd>{p.nodes.length}</dd></div>
        <div><dt>Files</dt><dd>{paths.length}</dd></div>
        <div><dt>To set up</dt><dd>{p.missing.length}</dd></div>
        <div><dt>Warnings</dt><dd>{p.warnings.length}</dd></div>
        {shared.length ? <div><dt>Shared context</dt><dd>{[...new Set(shared.map((s) => s.bundle))].join(', ')}</dd></div> : null}
      </dl>
      {p.summary ? <p className="draft-summary">{p.summary}</p> : null}
      {shared.length ? (
        <ul className="muted small draft-context" aria-label="Shared context">
          {[...new Set(shared.map((s) => s.node))].map((node) => <li key={node}>{node} takes {[...new Set(shared.filter((s) => s.node === node).map((s) => s.bundle))].map((b) => `${shared.filter((s) => s.node === node && s.bundle === b).map((s) => s.key).join(', ')} from ${b}`).join('; ')}</li>)}
        </ul>
      ) : null}
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
