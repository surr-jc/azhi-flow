import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../api';
import { ChatgptLogin } from '../components/ChatgptLogin';
import { CopilotLogin } from '../components/CopilotLogin';
import { GithubCliLogin } from '../components/GithubCliLogin';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Loading, PageHead, when } from '../ui';

interface SigninSecret { name: string; status: 'set' | 'missing'; kind?: 'gh-cli' | 'chatgpt' | 'copilot' | 'token'; version?: number; updated_at?: string; problem?: string; gh_ok?: boolean; host?: string }
interface Integration { id: string; title: string; description: string; accepts: string[]; cli: string; secrets: SigninSecret[] }
interface Status { integrations: Integration[]; other: SigninSecret[] }

const HOW: Record<string, string> = { 'gh-cli': 'GitHub CLI login', chatgpt: 'ChatGPT sign-in', copilot: 'Copilot sign-in', token: 'Pasted token' };

type Health = { tone: 'ok' | 'warn' | 'bad'; label: string };

function health(s: SigninSecret): Health {
  if (s.status === 'missing') return { tone: 'warn', label: 'Not connected' };
  if (s.problem) return { tone: 'bad', label: 'Needs a new sign-in' };
  if (s.kind === 'gh-cli' && !s.gh_ok) return { tone: 'bad', label: 'gh not signed in' };
  return { tone: 'ok', label: 'Ready' };
}

/** An integration is only as ready as its weakest secret. */
function overall(i: Integration): Health {
  const all = i.secrets.map(health);
  return all.find((h) => h.tone === 'bad') ?? all.find((h) => h.tone === 'warn') ?? { tone: 'ok', label: 'Ready' };
}

const ICONS: Record<string, string> = {
  github: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  copilot: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  chatgpt: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  default: 'M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7z',
};
const Icon = ({ id }: { id: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[id] ?? ICONS.default} /></svg>
);

/** The sign-in action for an integration: the same flows as the CLI, started from one place. */
function SigninAction({ i }: { i: Integration }) {
  if (i.id === 'github') return <GithubCliLogin secrets={i.secrets.map((x) => x.name)} />;
  if (i.id === 'copilot') return <CopilotLogin secret={i.secrets[0]!.name} />;
  if (i.id === 'chatgpt') return <ChatgptLogin secret={i.secrets[0]!.name} />;
  return (
    <p className="muted small">
      Paste a token on the <Link to="/ui/secrets">Secrets page</Link> as <code>{i.secrets[0]!.name}</code>, or run <code>{i.cli}</code>.
    </p>
  );
}

function IntegrationCard({ i }: { i: Integration }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const h = overall(i);
  const ready = h.tone === 'ok';
  const single = i.secrets.length === 1;
  const problem = i.secrets.find((x) => x.problem)?.problem;
  return (
    <section className={`si-card ${open ? 'open' : ''}`} aria-labelledby={`${regionId}-t`}>
      <header className="si-head">
        <span className="si-mark" aria-hidden="true"><Icon id={i.id} /></span>
        <div className="si-title">
          <h2 id={`${regionId}-t`}>{i.title}</h2>
          <p className="muted">{i.description}</p>
        </div>
        <Badge tone={`s ${h.tone}`}>{h.label}</Badge>
      </header>
      <ul className="si-secrets">
        {i.secrets.map((x) => {
          const sh = health(x);
          return (
            <li key={x.name}>
              <div className="si-secret-main">
                <span className="mono si-name">{x.name}</span>
                <span className="muted small">
                  {x.kind ? HOW[x.kind] : 'Nothing saved yet'}{x.host && x.host !== 'github.com' ? ` (${x.host})` : ''}
                  {x.updated_at ? <> · <span title={when(x.updated_at)}>updated {ago(x.updated_at)}</span></> : null}
                </span>
              </div>
              {single ? null : <span className={`si-dot ${sh.tone}`} title={sh.label} role="img" aria-label={sh.label} />}
            </li>
          );
        })}
      </ul>
      {problem ? <p className="si-note small">{problem}</p> : null}
      <footer className="si-foot">
        <button type="button" className={open ? 'ghost' : ready ? '' : 'primary'} aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : ready ? 'Change sign-in' : 'Sign in'}
        </button>
      </footer>
      {open ? <div id={regionId} className="si-action"><SigninAction i={i} /></div> : null}
    </section>
  );
}

/** Every sign-in in one place: which integration each secret serves, how it was supplied, and whether it fits. Values are never shown. */
export function Signins() {
  const [filter, setFilter] = useState<'all' | 'attention' | 'ready'>('all');
  const q = useQuery({ queryKey: ['secrets', 'signins'], queryFn: () => api<Status>('/v1/signins'), refetchInterval: 15_000 });
  const integrations = q.data?.integrations ?? [];
  const readyCount = integrations.filter((i) => overall(i).tone === 'ok').length;
  const needs = integrations.length - readyCount;
  // Needs-attention first, so the next action is always at the top.
  const shown = [...integrations]
    .sort((a, b) => Number(overall(a).tone === 'ok') - Number(overall(b).tone === 'ok'))
    .filter((i) => filter === 'all' || (filter === 'ready') === (overall(i).tone === 'ok'));
  const tabs = [['all', 'All', integrations.length], ['attention', 'Needs attention', needs], ['ready', 'Ready', readyCount]] as const;
  return (
    <>
      <PageHead title="Sign-ins" sub={<>Connect GitHub, Copilot, ChatGPT and the other services your workflows use. Nothing here shows a secret. The same list is available with <code>azhi signin list</code>.</>} />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : (
        <>
          {integrations.length ? (
            <div className="si-tabs" role="group" aria-label="Filter sign-ins">
              {tabs.map(([k, label, n]) => (
                <button key={k} type="button" className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {label} <span className="si-count">{n}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="si-grid">
            {shown.map((i) => <IntegrationCard key={i.id} i={i} />)}
          </div>
          {q.data.other.length ? (
            <details className="si-other">
              <summary>Other secrets <span className="muted">({q.data.other.length})</span></summary>
              <ul className="si-secrets">
                {q.data.other.map((x) => (
                  <li key={x.name}>
                    <div className="si-secret-main">
                      <span className="mono si-name">{x.name}</span>
                      <span className="muted small">{x.kind ? HOW[x.kind] : '—'} · <span title={when(x.updated_at)}>updated {ago(x.updated_at)}</span></span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </>
  );
}
