import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useMe } from '../App';
import { ago, Badge, ErrorNote, Loading, PageHead, Panel, Table, when } from '../ui';

/**
 * Users and roles (admin). Inviting by email lets the person sign in with single sign-on and get
 * the role given here; an API token is for the CLI, workers or a browser without SSO and is shown
 * once. Nobody changes their own role, the owner is never changed here, and only the owner makes
 * or changes admins (the server enforces all of it and audits every change).
 */
interface UserRow { id: string; display_name: string | null; email: string | null; role: string; created_at: string; disabled_at: string | null; slack_user_id: string | null; sso: boolean; tokens: number }

const ROLES = ['viewer', 'operator', 'author', 'admin'];

export function Users() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/v1/users') });
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api<{ sso: boolean }>('/v1/auth/config') });
  const [shown, setShown] = useState<{ who: string; token: string }>();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const change = useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/v1/users/${id}`, { method: 'PATCH', body }), onSuccess: refresh });
  const issue = useMutation({
    mutationFn: (u: UserRow) => api<{ token: string }>(`/v1/users/${u.id}/tokens`, { method: 'POST', body: {} }).then((r) => ({ who: u.display_name ?? u.email ?? u.id, token: r.token })),
    onSuccess: (r) => {
      setShown(r);
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (u: UserRow) => api(`/v1/users/${u.id}/tokens`, { method: 'DELETE' }), onSuccess: refresh });
  const owner = me.data?.role === 'owner';
  const manageable = (u: UserRow) => u.id !== me.data?.userId && u.role !== 'owner' && (owner || u.role !== 'admin');

  return (
    <>
      <PageHead title="Users" sub={config.data?.sso ? 'People sign in with single sign-on. Invite them by email to give them a role before they first sign in; anyone else starts as a viewer.' : 'Single sign-on is not set up, so people sign in with an API token.'} />
      <Panel title="Invite someone">
        <Invite sso={Boolean(config.data?.sso)} owner={owner} onToken={setShown} onDone={refresh} />
      </Panel>
      {shown ? (
        <div className="warn-note" role="status">
          <p>API token for {shown.who}. Copy it now: it is not shown again.</p>
          <div className="token-once"><code aria-label="New API token">{shown.token}</code><button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(shown.token)}>Copy</button><button type="button" className="small" onClick={() => setShown(undefined)}>Done</button></div>
        </div>
      ) : null}
      <ErrorNote error={change.error ?? issue.error ?? revoke.error} />
      <Panel>
        {!q.data ? <Loading /> : (
          <Table head={['User', 'Role', 'Sign-in', 'Slack user', 'Added', '']}>
            {q.data.map((u) => (
              <tr key={u.id} className={u.disabled_at ? 'muted' : ''}>
                <td>
                  {u.display_name ?? <span className="muted">no name</span>}{u.id === me.data?.userId ? <> <Badge>you</Badge></> : null}
                  <div className="muted small">{u.email ?? u.id}</div>
                </td>
                <td>
                  {manageable(u) ? (
                    <select aria-label={`Role of ${u.display_name ?? u.id}`} value={u.role} disabled={change.isPending} onChange={(e) => change.mutate({ id: u.id, body: { role: e.target.value } })}>
                      {ROLES.filter((r) => owner || r !== 'admin').map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : <Badge tone={u.role === 'owner' ? 'run' : undefined}>{u.role}</Badge>}
                </td>
                <td>
                  {u.disabled_at ? <Badge tone="bad">disabled</Badge> : null}
                  {u.sso ? <Badge tone="ok">SSO</Badge> : u.email && config.data?.sso ? <Badge tone="warn">invited</Badge> : null}
                  {u.tokens ? <Badge>{u.tokens} token{u.tokens > 1 ? 's' : ''}</Badge> : null}
                </td>
                <td><SlackUser user={u} editable={u.id === me.data?.userId || manageable(u)} onSave={(v) => change.mutate({ id: u.id, body: { slack_user_id: v } })} /></td>
                <td title={when(u.created_at)}>{ago(u.created_at)}</td>
                <td>
                  {manageable(u) ? (
                    <div className="row">
                      {!u.disabled_at ? <button type="button" className="small" disabled={issue.isPending} onClick={() => issue.mutate(u)}>New token</button> : null}
                      {u.tokens ? <button type="button" className="small" disabled={revoke.isPending} onClick={() => confirm(`Revoke every API token of ${u.display_name ?? u.id}?`) && revoke.mutate(u)}>Revoke tokens</button> : null}
                      <button type="button" className={`small ${u.disabled_at ? '' : 'danger'}`} disabled={change.isPending} onClick={() => change.mutate({ id: u.id, body: { disabled: !u.disabled_at } })}>{u.disabled_at ? 'Enable' : 'Disable'}</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}

function Invite({ sso, owner, onToken, onDone }: { sso: boolean; owner: boolean; onToken: (t: { who: string; token: string }) => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('operator');
  const [token, setToken] = useState(!sso);
  const create = useMutation({
    mutationFn: () => api<{ id: string; token?: string }>('/v1/users', { method: 'POST', body: { display_name: name.trim(), email: email.trim() || undefined, role, token: token || !sso } }),
    onSuccess: (r) => {
      if (r.token) onToken({ who: name.trim(), token: r.token });
      setName('');
      setEmail('');
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit}>
      <div className="row">
        <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input aria-label="Email" type="email" placeholder={sso ? 'Email they sign in with' : 'Email (optional)'} value={email} onChange={(e) => setEmail(e.target.value)} required={sso && !token} />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.filter((r) => owner || r !== 'admin').map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {sso ? <label className="row small"><input type="checkbox" checked={token} onChange={(e) => setToken(e.target.checked)} /> Also issue an API token</label> : null}
        <button type="submit" className="primary" disabled={create.isPending}>{sso ? 'Invite' : 'Add user'}</button>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}

function SlackUser({ user, editable, onSave }: { user: UserRow; editable: boolean; onSave: (v: string | null) => void }) {
  const [value, setValue] = useState(user.slack_user_id ?? '');
  if (!editable) return user.slack_user_id ? <span className="mono">{user.slack_user_id}</span> : <span className="muted">—</span>;
  const dirty = value.trim() !== (user.slack_user_id ?? '');
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); onSave(value.trim() || null); }}>
      <input aria-label={`Slack user of ${user.display_name ?? user.id}`} className="mono slack-id" placeholder="U0123ABCD" value={value} onChange={(e) => setValue(e.target.value)} pattern="[UW][A-Z0-9]{2,}" />
      {dirty ? <button type="submit" className="small">Save</button> : null}
    </form>
  );
}
