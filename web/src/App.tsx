import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, getToken, setToken, type Alert, type Me } from './api';
import { Link, match, useRoute } from './router';
import { Alerts } from './pages/Alerts';
import { Approvals } from './pages/Approvals';
import { Audit } from './pages/Audit';
import { Datasets, Tools } from './pages/Catalog';
import { Health } from './pages/Health';
import { Overview } from './pages/Overview';
import { RunPage } from './pages/Run';
import { Runs } from './pages/Runs';
import { Schedules } from './pages/Schedules';
import { Secrets } from './pages/Secrets';
import { Usage } from './pages/Usage';
import { Workers } from './pages/Workers';
import { WorkflowPage, Workflows } from './pages/Workflows';

export function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  useEffect(() => {
    const out = () => setSignedIn(false);
    addEventListener('azhi-signed-out', out);
    return () => removeEventListener('azhi-signed-out', out);
  }, []);
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;
  return <Shell />;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const qc = useQueryClient();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
    try {
      await api('/v1/me');
      qc.clear();
      onDone();
    } catch (err) {
      setToken(null);
      setError((err as Error).message);
    }
  };
  return (
    <main className="signin">
      <div className="brand big">Azhi Flow</div>
      <h1>Sign in</h1>
      <p className="muted">Paste an API token. <code>azhi open</code> prints a link that signs you in, and the local owner token is in your data folder's <code>local-token</code> file.</p>
      <form onSubmit={submit} className="row">
        <input type="password" placeholder="API token" autoComplete="off" aria-label="API token" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="primary">Open</button>
      </form>
      {error ? <div className="error">That token was not accepted: {error}</div> : null}
    </main>
  );
}

const NAV: Array<[string, string, string?]> = [
  ['/ui', 'Overview'],
  ['/ui/runs', 'Runs'],
  ['/ui/approvals', 'Approvals', 'approvals'],
  ['/ui/alerts', 'Alerts', 'alerts'],
  ['/ui/workflows', 'Workflows'],
  ['/ui/schedules', 'Schedules'],
  ['/ui/workers', 'Workers'],
  ['/ui/usage', 'Usage and limits'],
  ['/ui/secrets', 'Secrets', 'admin'],
  ['/ui/datasets', 'Datasets'],
  ['/ui/tools', 'Tools'],
  ['/ui/audit', 'Audit log', 'admin'],
  ['/ui/health', 'Health'],
];

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me'), staleTime: 60_000 });
}

function Shell() {
  const { path } = useRoute();
  const me = useMe();
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: () => api<unknown[]>('/v1/approvals'), refetchInterval: 5_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('/v1/alerts'), refetchInterval: 15_000 });
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  const critical = alerts.data?.filter((a) => a.level === 'critical').length ?? 0;
  const role = me.data?.role;
  return (
    <div className={`shell ${menu ? 'menu-open' : ''}`}>
      <header className="top">
        <button className="menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button>
        <Link to="/ui" className="brand">Azhi Flow</Link>
        <span className="top-right">
          {critical ? <Link to="/ui/alerts" className="badge bad">{critical} alert{critical > 1 ? 's' : ''}</Link> : null}
          {role ? <span className="muted small">{role}</span> : null}
          <button className="link small" onClick={() => { setToken(null); dispatchEvent(new Event('azhi-signed-out')); }}>Sign out</button>
        </span>
      </header>
      <nav className="side" aria-label="Main">
        {NAV.filter(([, , need]) => need !== 'admin' || ['admin', 'owner'].includes(role ?? '')).map(([to, label, extra]) => {
          const active = to === '/ui' ? path === '/ui' : path === to || path.startsWith(to + '/');
          const count = extra === 'approvals' ? approvals.data?.length : extra === 'alerts' ? critical : undefined;
          return (
            <Link key={to} to={to} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
              {label}
              {count ? <span className="count">{count}</span> : null}
            </Link>
          );
        })}
      </nav>
      <main className="content">
        <Page path={path} />
      </main>
    </div>
  );
}

function Page({ path }: { path: string }): ReactNode {
  let m: Record<string, string> | null;
  if (path === '/ui') return <Overview />;
  if (path === '/ui/runs') return <Runs />;
  if ((m = match('/ui/runs/:id', path))) return <RunPage id={m.id!} />;
  if (path === '/ui/approvals') return <Approvals />;
  if (path === '/ui/alerts') return <Alerts />;
  if (path === '/ui/workflows') return <Workflows />;
  if ((m = match('/ui/workflows/:slug', path))) return <WorkflowPage slug={m.slug!} />;
  if (path === '/ui/schedules') return <Schedules />;
  if (path === '/ui/workers') return <Workers />;
  if (path === '/ui/usage') return <Usage />;
  if (path === '/ui/secrets') return <Secrets />;
  if (path === '/ui/datasets') return <Datasets />;
  if (path === '/ui/tools') return <Tools />;
  if (path === '/ui/audit') return <Audit />;
  if (path === '/ui/health') return <Health />;
  return (
    <>
      <h1>Not found</h1>
      <p className="muted">There is no page at {path}.</p>
    </>
  );
}
