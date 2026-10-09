import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, applyTheme, atLeast, getTheme, getToken, setToken, type Alert, type Me, type Theme } from './api';
import { Icon } from './icons';
import { Link, match, useRoute } from './router';
import { Alerts } from './pages/Alerts';
import { Approvals } from './pages/Approvals';
import { Audit } from './pages/Audit';
import { Datasets, Tools } from './pages/Catalog';
import { Connections } from './pages/Connections';
import { Examples } from './pages/Examples';
import { Health } from './pages/Health';
import { Overview } from './pages/Overview';
import { RunPage } from './pages/Run';
import { Runs } from './pages/Runs';
import { Schedules } from './pages/Schedules';
import { Secrets } from './pages/Secrets';
import { Usage } from './pages/Usage';
import { Workers } from './pages/Workers';
import { WorkflowPage, Workflows } from './pages/Workflows';
import { UploadPackage } from './pages/Upload';
import { WorkflowBuilder } from './pages/Builder';
import { Users } from './pages/Users';
import { DatasetPage } from './pages/Authoring';
import { Assets } from './pages/Assets';

// The editor (and its YAML library) loads only when someone opens it.
const WorkflowEditor = lazy(() => import('./pages/Editor').then((m) => ({ default: m.WorkflowEditor })));

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
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api<{ sso: boolean; issuer?: string }>('/v1/auth/config'), retry: false });
  const next = location.pathname.startsWith('/ui') ? location.pathname + location.search : '/ui';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
    try {
      await api('/v1/me');
      qc.clear();
      onDone();
    } catch (err) {
      setToken(null);
      // A refused token is a 401/403; anything else is the server (or no server) answering.
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401 || status === 403
          ? `That token was not accepted: ${(err as Error).message}`
          : status
            ? `The server could not check the token (HTTP ${status}): ${(err as Error).message}. Look at the window where Azhi is running for the error.`
            : `Could not reach the Azhi server at ${location.host}. Check that it is running on this address and port.`,
      );
    }
  };
  return (
    <main className="signin">
      <div className="brand big">Azhi Flow</div>
      <h1>Sign in</h1>
      {config.data?.sso ? (
        <>
          <p><a className="button primary" href={`/v1/auth/login?next=${encodeURIComponent(next)}`}>Sign in with single sign-on</a></p>
          <p className="muted small">Signs in through {config.data.issuer}. Or use an API token:</p>
        </>
      ) : null}
      <p className="muted">Paste an API token. <code>azhi open</code> prints a link that signs you in, and the local owner token is in your data folder's <code>local-token</code> file.</p>
      <form onSubmit={submit} className="row">
        <input type="password" placeholder="API token" autoComplete="off" aria-label="API token" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="primary">Open</button>
      </form>
      {error ? <div className="error" role="alert">{error}</div> : null}
    </main>
  );
}

type NavItem = { to: string; label: string; need?: 'admin'; count?: 'approvals' | 'alerts' };
type Section = { label: string; to: string; icon: string; items: NavItem[]; count?: 'approvals' };

// Pages grouped by what a person is doing: deciding today, watching runs, building workflows,
// governing spend and access, and keeping the system running.
const SECTIONS: Section[] = [
  { label: 'Today', icon: 'home', to: '/ui', count: 'approvals', items: [] },
  { label: 'Runs', icon: 'runs', to: '/ui/runs', items: [{ to: '/ui/runs', label: 'All runs' }, { to: '/ui/approvals', label: 'Approvals', count: 'approvals' }, { to: '/ui/alerts', label: 'Alerts', count: 'alerts' }, { to: '/ui/schedules', label: 'Schedules' }] },
  { label: 'Workflows', icon: 'flow', to: '/ui/workflows', items: [{ to: '/ui/workflows', label: 'Workflows' }, { to: '/ui/assets', label: 'Portable assets' }, { to: '/ui/examples', label: 'Marketplace', need: 'admin' }, { to: '/ui/datasets', label: 'Datasets' }, { to: '/ui/tools', label: 'Tools' }, { to: '/ui/connections', label: 'Connections' }] },
  { label: 'Governance', icon: 'usage', to: '/ui/usage', items: [{ to: '/ui/usage', label: 'Usage and limits' }, { to: '/ui/audit', label: 'Audit log', need: 'admin' }, { to: '/ui/secrets', label: 'Secrets', need: 'admin' }] },
  { label: 'System', icon: 'server', to: '/ui/workers', items: [{ to: '/ui/workers', label: 'Workers' }, { to: '/ui/health', label: 'Health' }, { to: '/ui/users', label: 'Users', need: 'admin' }] },
];

const isAt = (to: string, path: string) => (to === '/ui' ? path === '/ui' : path === to || path.startsWith(to + '/'));
const sectionOf = (path: string) => (path === '/ui' ? SECTIONS[0] : SECTIONS.find((s) => s.items.some((i) => isAt(i.to, path))));

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me'), staleTime: 60_000 });
}

function Shell() {
  const { path } = useRoute();
  const me = useMe();
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: () => api<unknown[]>('/v1/approvals'), refetchInterval: 5_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alert[]>('/v1/alerts'), refetchInterval: 15_000 });
  const critical = alerts.data?.filter((a) => a.level === 'critical').length ?? 0;
  const role = me.data?.role;
  const allowed = (need?: 'admin') => need !== 'admin' || ['admin', 'owner'].includes(role ?? '');
  const counts = { approvals: approvals.data?.length ?? 0, alerts: critical };
  const current = sectionOf(path);
  const items = current?.items.filter((i) => allowed(i.need)) ?? [];
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <Link to="/ui" className="rail-logo" aria-label="Azhi Flow home" title="Azhi Flow">az</Link>
        {SECTIONS.map((s) => {
          const active = s === current;
          const count = s.count ? counts[s.count] : 0;
          return (
            <Link key={s.label} to={s.to} className={`rail-link ${active ? 'active' : ''}`} title={s.label} aria-label={count ? `${s.label}, ${count} waiting` : s.label} aria-current={active && s.to === path ? 'page' : undefined}>
              <Icon name={s.icon} size={22} />
              <span className="rail-label">{s.label}</span>
              {count ? <span className="rail-badge" aria-hidden="true">{count}</span> : null}
            </Link>
          );
        })}
        <span className="rail-gap" />
        <button type="button" className="rail-link" title="Sign out" aria-label="Sign out" onClick={() => { setToken(null); dispatchEvent(new Event('azhi-signed-out')); }}>
          <Icon name="signout" size={22} />
          <span className="rail-label">Sign out</span>
        </button>
      </nav>
      <div className="main">
        <header className="topbar">
          {current && items.length > 1 ? (
            <nav className="subnav" aria-label={current.label}>
              {items.map((i) => {
                const active = isAt(i.to, path);
                const count = i.count ? counts[i.count] : 0;
                return (
                  <Link key={i.to} to={i.to} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
                    {i.label}
                    {count ? <span className="count">{count}</span> : null}
                  </Link>
                );
              })}
            </nav>
          ) : <span className="topbar-title">{current?.label ?? 'Azhi Flow'}</span>}
          <span className="top-right">
            <ThemeSwitch />
            {critical ? <Link to="/ui/alerts" className="badge s bad">{critical} alert{critical > 1 ? 's' : ''}</Link> : null}
            {role ? <span className="role-pill">{role}</span> : null}
          </span>
        </header>
        <main className={`content${/^\/ui\/workflows\/[^/]+\/edit$/.test(path) ? ' wide' : ''}`}>
          <Page path={path} />
        </main>
      </div>
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
  if (path === '/ui/assets') return <Assets />;
  if (path === '/ui/workflows/upload') return <UploadPackage />;
  if (path === '/ui/workflows/new') return <WorkflowBuilder />;
  if ((m = match('/ui/workflows/:slug', path))) return <WorkflowPage slug={m.slug!} />;
  if ((m = match('/ui/workflows/:slug/edit', path))) return <Suspense fallback={<p className="muted">Loading…</p>}><WorkflowEditor slug={m.slug!} /></Suspense>;
  if (path === '/ui/examples' || path.startsWith('/ui/examples/')) return <Examples />;
  if (path === '/ui/schedules') return <Schedules />;
  if (path === '/ui/workers') return <Workers />;
  if (path === '/ui/usage') return <Usage />;
  if (path === '/ui/secrets') return <Secrets />;
  if (path === '/ui/users') return <Users />;
  if (path === '/ui/datasets') return <Datasets />;
  if ((m = match('/ui/datasets/:name', path))) return <DatasetRoute name={m.name!} />;
  if (path === '/ui/tools') return <Tools />;
  if (path === '/ui/connections') return <Connections />;
  if ((m = match('/ui/connections/:system', path))) return <Connections system={m.system!} />;
  if (path === '/ui/audit') return <Audit />;
  if (path === '/ui/health') return <Health />;
  return (
    <>
      <h1>Not found</h1>
      <p className="muted">There is no page at {path}.</p>
    </>
  );
}

function DatasetRoute({ name }: { name: string }) {
  const me = useMe();
  return <DatasetPage name={name} canEdit={atLeast(me.data?.role, 'author')} />;
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(getTheme());
  return (
    <select className="theme-switch" aria-label="Theme" value={theme} onChange={(e) => { const t = e.target.value as Theme; applyTheme(t); setTheme(t); }}>
      <option value="system">System theme</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
