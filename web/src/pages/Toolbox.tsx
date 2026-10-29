import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, atLeast } from '../api';
import { useMe } from '../App';
import { Popup } from '../components/Popup';
import { Icon } from '../icons';
import { Link } from '../router';
import { Badge, ErrorNote, Loading, PageHead } from '../ui';

/**
 * Everything an agent can be given, in one place: apps, skills, roles and commands, and knowledge.
 * Cards say what an item is for and whether it is ready; ids, versions and commands sit under Details.
 * The pages it grew from (Library, Connections, Datasets, Tools) stay reachable from each card.
 */
type Group = 'apps' | 'skills' | 'roles' | 'knowledge';
type Status = 'ready' | 'needs_setup' | 'draft' | 'unknown';
interface Item {
  id: string; group: Group; kind: string; name: string; summary: string; status: Status; status_note: string | null;
  changes_things: boolean | null; runs_code: boolean; needs: string[]; used_by: number; href: string; details: Record<string, any>;
}

const GROUPS: Array<{ key: Group | 'all'; label: string; icon: string; blurb: string }> = [
  { key: 'all', label: 'Everything', icon: 'flow', blurb: 'Everything your agents can use, in one place.' },
  { key: 'apps', label: 'Apps', icon: 'tool', blurb: 'Systems an agent can reach: GitHub, Jira, Slack, a database, your docs.' },
  { key: 'skills', label: 'Skills', icon: 'retrieve', blurb: 'Instructions an agent loads only when a task matches.' },
  { key: 'roles', label: 'Roles and commands', icon: 'agent', blurb: 'Specialist prompts and saved first tasks.' },
  { key: 'knowledge', label: 'Knowledge', icon: 'report', blurb: 'Documents an agent can search and cite: guidelines, runbooks, decisions.' },
];
const KIND_NAME: Record<string, string> = { app: 'App', connection: 'Hosted app', mcp: 'App', skill: 'Skill', agent: 'Role', command: 'Command', dataset: 'Knowledge' };
const STATUS: Record<Status, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'ok' },
  needs_setup: { label: 'Needs setup', tone: 'warn' },
  draft: { label: 'Draft', tone: 'warn' },
  unknown: { label: 'Not checked', tone: '' },
};

export function Toolbox() {
  const me = useMe();
  const q = useQuery({ queryKey: ['toolbox'], queryFn: () => api<Item[]>('/v1/toolbox') });
  const [group, setGroup] = useState<Group | 'all'>('all');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = atLeast(me.data?.role, 'author');
  const items = q.data ?? [];
  const counts = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g.key, g.key === 'all' ? items.length : items.filter((i) => i.group === g.key).length])) as Record<Group | 'all', number>, [items]);
  const needle = text.trim().toLowerCase();
  const shown = items.filter((i) => (group === 'all' || i.group === group) && (!needle || `${i.name} ${i.summary}`.toLowerCase().includes(needle)));
  const opened = items.find((i) => i.id === open);
  const attention = items.filter((i) => i.status === 'needs_setup').length;
  const current = GROUPS.find((g) => g.key === group)!;
  return (
    <>
      <PageHead
        title="Toolbox"
        sub="Everything your agents can use. Turn items on for a step from its editor; add new ones here."
        actions={canEdit ? <Link to="/ui/assets" className="button primary">Add to toolbox</Link> : undefined}
      />
      <ErrorNote error={q.error} />
      {attention ? <div className="update-note tb-alert" role="status"><span><b>{attention} item{attention === 1 ? ' needs' : 's need'} setup</b> before workflows can use {attention === 1 ? 'it' : 'them'}.</span></div> : null}
      <div className="tb">
        <nav className="tb-rail" aria-label="Toolbox categories">
          {GROUPS.map((g) => (
            <button key={g.key} type="button" className={`tb-cat${group === g.key ? ' on' : ''}`} aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
              <Icon name={g.icon} size={18} />
              <span>{g.label}</span>
              <span className="tb-count">{counts[g.key]}</span>
            </button>
          ))}
        </nav>
        <div className="tb-main">
          <label className="lib-q"><Icon name="search" size={18} /><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search the toolbox" aria-label="Search the toolbox" autoComplete="off" /></label>
          <p className="muted small tb-blurb">{current.blurb}</p>
          {!q.data && !q.error ? <Loading /> : null}
          {q.data && !shown.length ? (
            <div className="empty">
              <p className="empty-title">{items.length ? `Nothing matches${text ? ` “${text}”` : ''}.` : 'The toolbox is empty.'}</p>
              {!items.length && canEdit ? <p className="muted">Find an app or skill in the marketplace, or write your own. <Link to="/ui/assets">Add to toolbox</Link></p> : null}
            </div>
          ) : null}
          <div className="tb-grid">
            {shown.map((i) => <Card key={i.id} item={i} onOpen={() => setOpen(i.id)} />)}
          </div>
          <p className="muted small tb-adv">Looking for the raw lists? <Link to="/ui/connections">Connections</Link> · <Link to="/ui/tools">Tools</Link> · <Link to="/ui/assets">Library</Link> · <Link to="/ui/datasets">Datasets</Link></p>
        </div>
      </div>
      {opened ? <ItemDetails item={opened} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

const usedBy = (n: number) => (n ? `Used by ${n} workflow${n === 1 ? '' : 's'}` : 'Not used yet');

function Card({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const s = STATUS[item.status];
  return (
    <article className="tb-card">
      <header>
        <span className="tb-kind">{KIND_NAME[item.kind] ?? item.kind}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
      </header>
      <h3>{item.name}</h3>
      <p className="tb-sum">{item.summary || <span className="muted">No description.</span>}</p>
      {item.status_note ? <p className="small tb-note">{item.status_note}</p> : null}
      <p className="small tb-flags">
        {item.changes_things ? <Badge tone="warn">can change things</Badge> : null}
        {item.runs_code ? <Badge tone="warn">runs code on a worker</Badge> : null}
        {item.needs.length ? <Badge>needs {item.needs.length} value{item.needs.length === 1 ? '' : 's'}</Badge> : null}
        <span className="muted">{usedBy(item.used_by)}</span>
      </p>
      <div className="row">
        <button type="button" onClick={onOpen} aria-haspopup="dialog">Details</button>
        <Link to={item.href} className="small">Manage</Link>
      </div>
    </article>
  );
}

/** What an item is, in a dialog over the page: its needs, its actions and the technical facts. */
function ItemDetails({ item, onClose }: { item: Item; onClose: () => void }) {
  const s = STATUS[item.status];
  const tools = (item.details.tools ?? []) as Array<{ ref: string; description: string; effect: string }>;
  const facts = Object.entries(item.details).filter(([k, v]) => k !== 'tools' && v !== null && v !== '');
  return (
    <Popup title={item.name} sub={KIND_NAME[item.kind] ?? item.kind} size="wide" onClose={onClose} footer={<div className="row"><Link to={item.href} className="button primary">Manage</Link><button type="button" onClick={onClose}>Close</button></div>}>
      <div className="tb-details">
        <p className="small tb-flags">
          <Badge tone={s.tone}>{s.label}</Badge>
          {item.changes_things ? <Badge tone="warn">can change things</Badge> : null}
          {item.runs_code ? <Badge tone="warn">runs code on a worker</Badge> : null}
          <span className="muted">{usedBy(item.used_by)}</span>
        </p>
        {item.summary ? <p>{item.summary}</p> : null}
        {item.status_note ? <p className="small tb-note">{item.status_note}</p> : null}
        {item.needs.length ? <p className="small"><b>Needs:</b> <span className="mono">{item.needs.join(', ')}</span></p> : null}
        {tools.length ? (
          <>
            <h4 className="tb-h">Actions</h4>
            <ul className="tb-tools">
              {tools.map((t) => <li key={t.ref}><span className="mono">{t.ref}</span> <Badge tone={t.effect === 'read' ? 'ok' : 'warn'}>{t.effect === 'read' ? 'read' : 'writes'}</Badge><span className="muted small">{t.description}</span></li>)}
            </ul>
          </>
        ) : null}
        {facts.length ? (
          <dl className="tb-facts small">
            {facts.map(([k, v]) => <div key={k}><dt>{k.replaceAll('_', ' ')}</dt><dd className="mono">{String(v)}</dd></div>)}
          </dl>
        ) : null}
      </div>
    </Popup>
  );
}
