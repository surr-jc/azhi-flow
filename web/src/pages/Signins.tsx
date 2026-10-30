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
  if (s.status === 'missing') return { tone: 'warn', label: 'not set' };
  if (s.problem) return { tone: 'bad', label: 'wrong kind' };
  if (s.kind === 'gh-cli' && !s.gh_ok) return { tone: 'bad', label: 'gh not signed in' };
  return { tone: 'ok', label: 'ready' };
}

/** An integration is only as ready as its weakest secret. */
function overall(i: Integration): Health {
  const all = i.secrets.map(health);
  return all.find((h) => h.tone === 'bad') ?? all.find((h) => h.tone === 'warn') ?? { tone: 'ok', label: 'ready' };
}

const StatusBadge = ({ h }: { h: Health }) => <Badge tone={`s ${h.tone}`}>{h.label}</Badge>;

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
  return (
    <section className={`si-card ${ready ? '' : 'needs'}`} aria-labelledby={`${regionId}-t`}>
      <header className="si-head">
        <span className={`si-mark ${h.tone}`} aria-hidden="true">{i.title.slice(0, 1).toUpperCase()}</span>
        <div className="si-title">
          <h2 id={`${regionId}-t`}>{i.title}</h2>
          <p className="muted small">{i.description}</p>
        </div>
        <StatusBadge h={h} />
      </header>
      <ul className="si-secrets">
        {i.secrets.map((x) => {
          const sh = health(x);
          return (
            <li key={x.name}>
              <div className="si-secret-main">
                <span className="mono si-name">{x.name}</span>
                <span className="muted small">
                  {x.kind ? HOW[x.kind] : 'Not supplied'}{x.host && x.host !== 'github.com' ? ` (${x.host})` : ''}
                  {x.updated_at ? <> · <span title={when(x.updated_at)}>updated {ago(x.updated_at)}</span></> : null}
                </span>
                {x.problem ? <span className="small warn-text">{x.problem}</span> : null}
              </div>
              <StatusBadge h={sh} />
            </li>
          );
        })}
      </ul>
      <footer className="si-foot">
        <button
          type="button"
          className={ready ? '' : 'primary'}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Close' : ready ? 'Sign in again or switch method' : 'Sign in'}
        </button>
      </footer>
      {open ? <div id={regionId} className="si-action"><SigninAction i={i} /></div> : null}
    </section>
  );
}

/** Every sign-in in one place: which integration each secret serves, how it was supplied, and whether it fits. Values are never shown. */
export function Signins() {
  const q = useQuery({ queryKey: ['secrets', 'signins'], queryFn: () => api<Status>('/v1/signins'), refetchInterval: 15_000 });
  const integrations = q.data?.integrations ?? [];
  const readyCount = integrations.filter((i) => overall(i).tone === 'ok').length;
  const needs = integrations.length - readyCount;
  // Needs-attention first, so the next action is always at the top.
  const sorted = [...integrations].sort((a, b) => Number(overall(a).tone === 'ok') - Number(overall(b).tone === 'ok'));
  return (
    <>
      <PageHead title="Sign-ins" sub={<>Connect GitHub, Copilot, ChatGPT and the other services your workflows use. Nothing here shows a secret. The same list is available with <code>azhi signin list</code>.</>} />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : (
        <>
          {integrations.length ? (
            <div className={`si-summary ${needs ? 'warn' : 'ok'}`} role="status">
              <div className="si-meter" aria-hidden="true"><span style={{ width: `${(readyCount / integrations.length) * 100}%` }} /></div>
              <strong>{readyCount} of {integrations.length} connected</strong>
              <span className="muted">{needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} attention` : 'Everything is ready for your workflows'}</span>
            </div>
          ) : null}
          <div className="si-grid">
            {sorted.map((i) => <IntegrationCard key={i.id} i={i} />)}
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
