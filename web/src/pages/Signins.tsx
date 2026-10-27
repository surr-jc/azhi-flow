import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ChatgptLogin } from '../components/ChatgptLogin';
import { CopilotLogin } from '../components/CopilotLogin';
import { GithubCliLogin } from '../components/GithubCliLogin';
import { Link } from '../router';
import { ago, Badge, ErrorNote, Loading, PageHead, Panel, Table, when } from '../ui';

interface SigninSecret { name: string; status: 'set' | 'missing'; kind?: 'gh-cli' | 'chatgpt' | 'copilot' | 'token'; version?: number; updated_at?: string; problem?: string; gh_ok?: boolean; host?: string }
interface Integration { id: string; title: string; description: string; accepts: string[]; cli: string; secrets: SigninSecret[] }
interface Status { integrations: Integration[]; other: SigninSecret[] }

const HOW: Record<string, string> = { 'gh-cli': 'GitHub CLI login', chatgpt: 'ChatGPT sign-in', copilot: 'Copilot sign-in', token: 'Pasted token' };

function Health({ s }: { s: SigninSecret }) {
  if (s.status === 'missing') return <Badge tone="warn">not set</Badge>;
  if (s.problem) return <Badge tone="bad">wrong kind</Badge>;
  if (s.kind === 'gh-cli' && !s.gh_ok) return <Badge tone="bad">gh not signed in</Badge>;
  return <Badge tone="ok">ready</Badge>;
}

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

/** Every sign-in in one place: which integration each secret serves, how it was supplied, and whether it fits. Values are never shown. */
export function Signins() {
  const q = useQuery({ queryKey: ['secrets', 'signins'], queryFn: () => api<Status>('/v1/signins'), refetchInterval: 15_000 });
  return (
    <>
      <PageHead title="Sign-ins" sub={<>Sign in to GitHub, Copilot, ChatGPT and the other services your workflows use. Nothing here shows a secret. The same list is available with <code>azhi signin list</code>.</>} />
      <ErrorNote error={q.error} />
      {!q.data ? <Loading /> : (
        <div className="stack">
          {q.data.integrations.map((i) => (
            <Panel key={i.id} title={i.title}>
              <p className="muted small">{i.description}</p>
              <Table head={['Secret', 'Supplied by', 'Status', 'Updated']}>
                {i.secrets.map((x) => (
                  <tr key={x.name}>
                    <td className="mono">{x.name}</td>
                    <td>{x.kind ? HOW[x.kind] : '—'}{x.host && x.host !== 'github.com' ? ` (${x.host})` : ''}</td>
                    <td><Health s={x} />{x.problem ? <div className="small warn-text">{x.problem}</div> : null}</td>
                    <td title={when(x.updated_at)}>{ago(x.updated_at)}</td>
                  </tr>
                ))}
              </Table>
              <details>
                <summary>{i.secrets.every((x) => x.status === 'set' && !x.problem) ? 'Sign in again or switch method' : 'Sign in'}</summary>
                <SigninAction i={i} />
              </details>
            </Panel>
          ))}
          {q.data.other.length ? (
            <Panel title="Other secrets">
              <Table head={['Secret', 'Supplied by', 'Updated']}>
                {q.data.other.map((x) => (
                  <tr key={x.name}><td className="mono">{x.name}</td><td>{x.kind ? HOW[x.kind] : '—'}</td><td title={when(x.updated_at)}>{ago(x.updated_at)}</td></tr>
                ))}
              </Table>
            </Panel>
          ) : null}
        </div>
      )}
    </>
  );
}
