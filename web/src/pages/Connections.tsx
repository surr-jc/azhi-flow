import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, atLeast, type JsonSchema } from '../api';
import { useMe } from '../App';
import { RepoList } from '../components/RepoAccess';
import { Link, useRoute } from '../router';
import { Badge, ErrorNote, Loading, PageHead, Table } from '../ui';

/**
 * Everything the workflows reach outside Azhi, one page per system: its tokens, the repositories
 * its GitHub tools may use (checked against the token), each tool with what it accepts, which
 * steps use it and what it wrote lately. A change here can be judged by the steps it touches.
 */
interface Tool { id: string; version: number; description: string; effect: string; credential?: string; input_schema?: JsonSchema; transport?: { kind?: string; config?: { repos?: string[] } }; revision?: number }
interface Use { workflow: string; node: string; version: number; draft: boolean }
interface Usage { tools: Record<string, Use[]>; secrets: Record<string, Use[]>; datasets: Record<string, Use[]>; writes: Record<string, { confirmed: number; failed: number; unknown: number }> }
interface Dataset { name: string; trusted: boolean; latest_revision: number | null; documents: number }

const NAMES: Record<string, string> = { github: 'GitHub', slack: 'Slack', jira: 'Jira', ci: 'CI', ticket: 'Tickets' };
const nameOf = (system: string) => NAMES[system] ?? system.charAt(0).toUpperCase() + system.slice(1);
const ref = (t: Tool) => `${t.id}@${t.version}`;

export function Connections({ system }: { system?: string }) {
  const me = useMe();
  const admin = atLeast(me.data?.role, 'admin');
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/v1/tools') });
  const usage = useQuery({ queryKey: ['connection-usage'], queryFn: () => api<Usage>('/v1/connections/usage') });
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => api<Array<{ name: string }>>('/v1/secrets'), enabled: admin });
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api<Dataset[]>('/v1/datasets') });
  const set = new Set((secrets.data ?? []).map((s) => s.name));
  const known = admin && secrets.data !== undefined;
  const groups = new Map<string, Tool[]>();
  for (const t of tools.data ?? []) groups.set(t.id.split('.')[0]!, [...(groups.get(t.id.split('.')[0]!) ?? []), t]);
  const systems = [...groups.keys()].sort();
  const current = system ?? 'github';
  const selected = current === 'datasets' ? 'datasets' : groups.has(current) ? current : systems[0];
  const missing = (list: Tool[]) => [...new Set(list.map((t) => t.credential).filter((c): c is string => Boolean(c)))].filter((c) => known && !set.has(c));
  return (
    <>
      <PageHead title="Connections" sub="The systems your workflows reach: their tokens, the repositories they may use, each tool and the steps that call it. To give a harness agent its own MCP server, use the Library." />
      <ErrorNote error={tools.error ?? usage.error} />
      {!tools.data ? <Loading /> : (
        <div className="conn">
          <nav className="conn-list" aria-label="Systems">
            {systems.map((s) => {
              const m = missing(groups.get(s)!);
              return (
                <Link key={s} to={`/ui/connections/${s}`} className={`conn-item${selected === s ? ' on' : ''}`} aria-current={selected === s ? 'page' : undefined}>
                  <b>{nameOf(s)}</b>
                  <span className="muted small">{groups.get(s)!.length} tool{groups.get(s)!.length === 1 ? '' : 's'}</span>
                  {m.length ? <Badge tone="warn">{m.length} missing</Badge> : known ? <Badge tone="ok">ready</Badge> : null}
                </Link>
              );
            })}
            <Link to="/ui/connections/datasets" className={`conn-item${selected === 'datasets' ? ' on' : ''}`} aria-current={selected === 'datasets' ? 'page' : undefined}>
              <b>Datasets</b>
              <span className="muted small">{datasets.data?.length ?? 0}</span>
            </Link>
          </nav>
          <div className="conn-detail">
            {selected === 'datasets' ? <DatasetsView datasets={datasets.data} usage={usage.data} /> : selected ? <SystemView system={selected} tools={groups.get(selected)!} usage={usage.data} set={set} known={known} admin={admin} /> : <p className="muted">No tools are registered yet.</p>}
          </div>
        </div>
      )}
    </>
  );
}

const use = (u: Use) => (
  <Link key={`${u.workflow}/${u.node}`} to={`/ui/workflows/${encodeURIComponent(u.workflow)}`} className="chip-link" title={`${u.workflow} v${u.version}${u.draft ? ' (draft)' : ''}`}>{u.workflow} › {u.node}</Link>
);

function SystemView({ system, tools, usage, set, known, admin }: { system: string; tools: Tool[]; usage?: Usage; set: Set<string>; known: boolean; admin: boolean }) {
  const qc = useQueryClient();
  const creds = [...new Set(tools.map((t) => t.credential).filter((c): c is string => Boolean(c)))].sort();
  const gh = tools.filter((t) => Array.isArray(t.transport?.config?.repos));
  const refs = gh.map(ref);
  const repos = [...new Map(gh.flatMap((t) => t.transport!.config!.repos!).map((r) => [r.toLowerCase(), r])).values()];
  return (
    <>
      <div className="row"><h2>{nameOf(system)}</h2><Badge>{tools.length} tool{tools.length === 1 ? '' : 's'}</Badge></div>
      <div className="sd-group">
        <h3>Tokens</h3>
        {creds.length ? creds.map((c) => (
          <div key={c} className="cfg-row">
            <div className="cfg-k mono small">{c}</div>
            <div className="cfg-v">
              {known ? <Badge tone={set.has(c) ? 'ok' : 'warn'}>{set.has(c) ? 'set' : 'missing'}</Badge> : <span className="muted small">visible to admins</span>}
              <div className="cfg-from"><span className="muted small">used by</span>{(usage?.secrets[c] ?? []).length ? usage!.secrets[c]!.map(use) : <span className="muted small">no step</span>}</div>
            </div>
          </div>
        )) : <p className="muted small">These tools need no token.</p>}
        {admin ? <p className="small"><Link to="/ui/secrets">Set or replace tokens</Link></p> : null}
      </div>
      {gh.length ? (
        <div className="sd-group">
          <h3>Allowed repositories</h3>
          <p className="muted small">Every GitHub tool above refuses any other repository. Each repository is checked against the token of the tool that uses it.</p>
          <RepoList
            refs={refs}
            repos={repos}
            canEdit={admin}
            change={async (c) => {
              for (const r of refs) await api(`/v1/tools/${encodeURIComponent(r)}/repos`, { method: 'POST', body: c });
            }}
            onChanged={() => void qc.invalidateQueries({ queryKey: ['tools'] })}
          />
        </div>
      ) : null}
      <div className="sd-group">
        <h3>Tools</h3>
        <Table head={['Tool', 'Effect', 'Accepts', 'Used by', 'Writes, 7 days']}>
          {[...tools].sort((a, b) => a.id.localeCompare(b.id)).map((t) => {
            const props = Object.keys(t.input_schema?.properties ?? {});
            const required = new Set(t.input_schema?.required ?? []);
            const w = usage?.writes[ref(t)] ?? usage?.writes[t.id];
            const users = usage?.tools[ref(t)] ?? [];
            return (
              <tr key={ref(t)}>
                <td><span className="mono">{ref(t)}</span><div className="muted small">{t.description}</div></td>
                <td><Badge tone={t.effect === 'read' ? 'ok' : t.effect === 'write-unsafe' ? 'bad' : 'warn'}>{t.effect}</Badge></td>
                <td className="mono small">{props.length ? props.map((p) => `${p}${required.has(p) ? '*' : ''}`).join(', ') : <span className="muted">anything</span>}</td>
                <td><div className="cfg-from">{users.length ? users.map(use) : <span className="muted small">no step</span>}</div></td>
                <td>{t.effect === 'read' ? <span className="muted">—</span> : w ? <>{w.confirmed} done{w.failed ? <>, <span className="warn-text">{w.failed} failed</span></> : null}{w.unknown ? <>, <span className="warn-text">{w.unknown} unknown</span></> : null}</> : <span className="muted">none</span>}</td>
              </tr>
            );
          })}
        </Table>
        <p className="muted small">Writes are recorded in each run's action ledger. <Link to="/ui/tools">Register or change tools</Link></p>
      </div>
    </>
  );
}

function DatasetsView({ datasets, usage }: { datasets?: Dataset[]; usage?: Usage }) {
  if (!datasets) return <Loading />;
  return (
    <>
      <div className="row"><h2>Datasets</h2><Badge>{datasets.length}</Badge></div>
      <p className="muted small">Knowledge that agent and retrieve steps read. Each is pinned per run, so publishing a new revision changes nothing until a tag moves.</p>
      <Table head={['Dataset', 'Trust', 'Documents', 'Revision', 'Read by']} empty="No datasets yet.">
        {datasets.map((d) => (
          <tr key={d.name}>
            <td><Link to={`/ui/datasets/${encodeURIComponent(d.name)}`} className="mono">{d.name}</Link></td>
            <td>{d.trusted ? <Badge tone="ok">trusted</Badge> : <Badge tone="warn">untrusted</Badge>}</td>
            <td>{d.documents}</td>
            <td>{d.latest_revision ? `r${d.latest_revision}` : <span className="muted">unpublished</span>}</td>
            <td><div className="cfg-from">{(usage?.datasets[d.name] ?? []).length ? usage!.datasets[d.name]!.map(use) : <span className="muted small">no step</span>}</div></td>
          </tr>
        ))}
      </Table>
    </>
  );
}
