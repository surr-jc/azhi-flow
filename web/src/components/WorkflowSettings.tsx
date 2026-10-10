import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { JsonSchema, RunPlan, ScheduleRow } from '../api';
import { api, atLeast } from '../api';
import { ScheduleForm, WorkflowFiles } from '../pages/Authoring';
import { Link } from '../router';
import { Badge, Loading, Table, when } from '../ui';
import type { ToolInfo } from '../stepHelp';
import { ConfigRow } from './ConfigRow';
import { ModelSteps } from './ModelChoice';
import { RepoList } from './RepoAccess';
import type { PlanNode } from './WorkflowCanvas';

/**
 * The settings that belong to the whole workflow, as a dock beside the canvas. Each row is a
 * one-line summary with a status, and opens a popup with the full setting and what it means.
 */
export interface ToolRow extends ToolInfo { credential?: string; transport?: { kind?: string; config?: { repos?: string[] } } }
export interface VersionRow { id: string; version: number; draft: boolean; package_hash: string; signed: boolean; created_at: string }
export interface PortableAsset { id: string; kind: string; slug: string; name: string; version: number }

export interface SettingsData {
  slug: string;
  version: VersionRow;
  def: Record<string, any> | undefined;
  nodes: PlanNode[];
  plan?: RunPlan;
  tools: ToolRow[];
  role?: string;
  schedule?: ScheduleRow;
  schedulesLoaded: boolean;
  hasPublished: boolean;
  assets?: PortableAsset[];
}

export type SectionId = 'inputs' | 'config' | 'models' | 'trigger' | 'secrets' | 'connections' | 'datasets' | 'limits' | 'assets' | 'files';
interface Section { id: SectionId; icon: string; title: string; summary: string; chip?: { label: string; tone?: string } }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const toolOf = (tools: ToolRow[], ref: unknown) => (typeof ref === 'string' ? tools.find((t) => `${t.id}@${t.version}` === ref) : undefined);

/** Secret name to the steps that use it: tool credentials and agent workspace credentials. */
export function secretUse(d: SettingsData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (secret: unknown, node: string) => typeof secret === 'string' && secret && out.set(secret, [...(out.get(secret) ?? []), node]);
  for (const n of d.nodes) {
    const def = n.def ?? {};
    if (n.type === 'tool') add(toolOf(d.tools, def.tool)?.credential, n.id);
    if (n.type === 'notify') add(d.tools.find((t) => t.id.startsWith('slack.'))?.credential, n.id);
    if (n.type === 'agent') add(def.workspace?.credential, n.id);
  }
  for (const g of d.plan?.missing_grants ?? []) if (g.kind === 'secret' && !out.has(g.name)) out.set(g.name, [g.node]);
  return out;
}

const missingSecrets = (d: SettingsData) => new Set((d.plan?.missing_grants ?? []).filter((g) => g.kind === 'secret').map((g) => g.name));

/** Dataset names (without the @tag) the steps read. */
export function datasetsUsed(nodes: PlanNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    const list = n.def?.datasets;
    if (Array.isArray(list)) for (const d of list) if (typeof d === 'string') out.set(d, [...(out.get(d) ?? []), n.id]);
  }
  return out;
}

const inputsOf = (d: SettingsData): Array<[string, JsonSchema]> => Object.entries(((d.def?.inputs as JsonSchema | undefined)?.properties ?? {}) as Record<string, JsonSchema>);
const configOf = (d: SettingsData): Array<[string, unknown]> => Object.entries((d.def?.config ?? {}) as Record<string, unknown>);
const unfilled = (v: unknown) => typeof v === 'string' && /\{\{[^}]+\}\}/.test(v);

/** One line for the Models row: the workflow's default provider and model, or who decides. */
function modelSummary(d: SettingsData): string {
  const md = d.def?.model_defaults as { provider?: string; name?: string } | undefined;
  const agents = (d.plan?.nodes ?? []).filter((n) => n.model);
  const own = agents.filter((n) => n.model!.source === 'profile').length;
  const base = md?.provider ? `${md.provider}${md.name ? `, ${md.name}` : ', server default model'}` : 'Each step\'s own default';
  return agents.length ? `${base} · ${plural(agents.length - own, 'step')} follow it, ${own} keep their own` : base;
}

export function sectionsOf(d: SettingsData): Section[] {
  const inputs = inputsOf(d);
  const required = new Set((d.def?.inputs as JsonSchema | undefined)?.required ?? []);
  const config = configOf(d);
  const secrets = secretUse(d);
  const missing = missingSecrets(d);
  const setCount = [...secrets.keys()].filter((s) => !missing.has(s)).length;
  const used = d.nodes.filter((n) => n.type === 'tool').map((n) => toolOf(d.tools, n.def?.tool)).filter((t): t is ToolRow => Boolean(t));
  const tools = [...new Map(used.map((t) => [`${t.id}@${t.version}`, t])).values()];
  const datasets = datasetsUsed(d.nodes);
  const limited = d.nodes.filter((n) => n.def?.timeout || n.def?.budget || n.def?.retry || n.def?.limits);
  const sched = d.def?.trigger?.schedule as { cron?: string; timezone?: string } | undefined;
  const live = d.schedule;
  return [
    { id: 'inputs', icon: '⇥', title: 'Inputs', summary: inputs.length ? inputs.map(([k]) => `${k}${required.has(k) ? '*' : ''}`).join(', ') : 'Takes no inputs', chip: { label: String(inputs.length) } },
    { id: 'config', icon: '⚙', title: 'Config', summary: config.length ? config.map(([k, v]) => `${k} = ${unfilled(v) ? 'not set' : String(v)}`).join(', ') : 'None', chip: config.length ? (config.some(([, v]) => unfilled(v)) ? { label: 'not set', tone: 'warn' } : { label: 'set', tone: 'ok' }) : undefined },
    { id: 'models', icon: '✦', title: 'Models', summary: modelSummary(d), chip: d.def?.model_defaults?.provider ? { label: 'set', tone: 'ok' } : undefined },
    { id: 'trigger', icon: '◷', title: 'Trigger', summary: live ? `${live.cron} (${live.timezone})${live.enabled ? '' : ', off'}` : sched?.cron ? `${sched.cron} (${sched.timezone ?? 'UTC'})` : 'Manual only' },
    { id: 'secrets', icon: '⚿', title: 'Secrets', summary: secrets.size ? [...secrets.keys()].join(', ') : 'None used', chip: secrets.size ? { label: `${setCount} of ${secrets.size}`, tone: setCount === secrets.size ? 'ok' : 'warn' } : undefined },
    { id: 'connections', icon: '⛓', title: 'Connections', summary: tools.length ? [...new Set(tools.map((t) => t.id.split('.')[0]))].join(' · ') : 'No tools called', chip: { label: String(tools.length) } },
    { id: 'datasets', icon: '☰', title: 'Datasets', summary: datasets.size ? [...datasets.keys()].join(', ') : 'None used', chip: { label: String(datasets.size) } },
    { id: 'limits', icon: '◈', title: 'Limits', summary: limited.length ? `${plural(limited.length, 'step')} with a limit` : 'Defaults only', chip: { label: String(limited.length) } },
    { id: 'assets', icon: '❖', title: 'Library items', summary: d.assets ? (d.assets.length ? d.assets.map((a) => a.name).join(', ') : 'None attached') : '…', chip: d.assets ? { label: String(d.assets.length) } : undefined },
    { id: 'files', icon: '✎', title: 'Version and files', summary: `v${d.version.version}${d.version.draft ? ' draft' : ''} · ${plural(d.nodes.length, 'step')}` },
  ];
}

/** The dock: the sections as rows, or as icons only while a step is open. */
export function SettingsDock({ data, collapsed, active, onOpen }: { data: SettingsData; collapsed: boolean; active?: SectionId; onOpen: (id: SectionId) => void }) {
  const sections = sectionsOf(data);
  if (collapsed) {
    return (
      <nav className="dock dock-rail" aria-label="Workflow settings">
        {sections.map((s) => <button key={s.id} type="button" className="dock-icon" title={`${s.title}: ${s.summary}`} aria-label={s.title} onClick={() => onOpen(s.id)}>{s.icon}</button>)}
      </nav>
    );
  }
  return (
    <nav className="dock" aria-label="Workflow settings">
      <h2 className="dock-head">Workflow settings</h2>
      {sections.map((s) => (
        <button key={s.id} type="button" className={`dock-row${active === s.id ? ' on' : ''}`} onClick={() => onOpen(s.id)}>
          <span className="dock-icon" aria-hidden="true">{s.icon}</span>
          <span className="dock-text"><b>{s.title}</b><span className="muted small">{s.summary}</span></span>
          {s.chip ? <Badge tone={s.chip.tone}>{s.chip.label}</Badge> : null}
        </button>
      ))}
      <p className="dock-foot muted small">Each row opens the full setting and what it means.</p>
    </nav>
  );
}

/** The popup body: a list of sections on the left, the chosen one on the right. */
export function SettingsBody({ data, section, onSection, onClose }: { data: SettingsData; section: SectionId; onSection: (id: SectionId) => void; onClose: () => void }) {
  const sections = sectionsOf(data);
  return (
    <div className="settings-pop">
      <nav className="settings-nav" aria-label="Sections">
        {sections.map((s) => (
          <button key={s.id} type="button" className={s.id === section ? 'on' : ''} aria-current={s.id === section ? 'true' : undefined} onClick={() => onSection(s.id)}>
            {s.title}{s.chip ? <span className="muted small">{s.chip.label}</span> : null}
          </button>
        ))}
      </nav>
      <div className="settings-main">
        <Section data={data} id={section} onClose={onClose} />
      </div>
    </div>
  );
}

function Section({ data: d, id, onClose }: { data: SettingsData; id: SectionId; onClose: () => void }): ReactNode {
  const admin = atLeast(d.role, 'admin');
  const author = atLeast(d.role, 'author');
  switch (id) {
    case 'inputs': {
      const required = new Set((d.def?.inputs as JsonSchema | undefined)?.required ?? []);
      const rows = inputsOf(d);
      return (
        <>
          <p className="muted">What a person provides when starting a run. Steps read them as <span className="mono">inputs.name</span>.</p>
          {rows.length ? rows.map(([k, p]) => (
            <ConfigRow key={k} label={<><span className="mono">{k}</span>{required.has(k) ? <span className="req"> *</span> : null}</>} value={`${Array.isArray(p.type) ? p.type.join(' or ') : p.type ?? 'string'}${p.default !== undefined ? `, default ${String(p.default)}` : ''}`} help={p.title ? `${p.title}${p.description ? `. ${p.description}` : ''}` : p.description} />
          )) : <p className="muted">This workflow takes no inputs.</p>}
        </>
      );
    }
    case 'config': {
      const rows = configOf(d);
      return (
        <>
          <p className="muted">Values fixed when the workflow was installed. Steps read them as <span className="mono">config.name</span>.</p>
          {rows.length ? rows.map(([k, v]) => <ConfigRow key={k} label={<span className="mono">{k}</span>} value={unfilled(v) ? 'not set' : typeof v === 'string' ? v : JSON.stringify(v)} tone={unfilled(v) ? 'warn' : undefined} help={unfilled(v) ? 'This was left blank when installed. Set it from the template page of this workflow, then publish again.' : undefined} />) : <p className="muted">This workflow has no config values.</p>}
        </>
      );
    }
    case 'models': {
      const md = d.def?.model_defaults as { provider?: string; name?: string } | undefined;
      return (
        <>
          <p className="muted">The provider and model for every agent step whose profile says <span className="mono">name: default</span>. A step that names its own provider and model keeps them. A person starting a run can choose another provider and model for that run.</p>
          <ConfigRow label="Workflow default" value={md?.provider ? `${md.provider}${md.name ? `, ${md.name}` : ', the provider\'s server default model'}` : 'none: each default-model step uses the server\'s provider and model'} help={atLeast(d.role, 'author') ? undefined : 'Changing it needs the author role.'} />
          <ModelSteps plan={d.plan} />
          {atLeast(d.role, 'author') ? <p><Link to={`/ui/workflows/${encodeURIComponent(d.slug)}/edit?from=${encodeURIComponent(d.version.id)}`}>Change it in the editor</Link></p> : null}
        </>
      );
    }
    case 'trigger': {
      const sched = d.def?.trigger?.schedule as { cron?: string; timezone?: string } | undefined;
      return (
        <>
          <ConfigRow label="Starts" value={d.schedule ? `on a schedule: ${d.schedule.cron} (${d.schedule.timezone})` : sched?.cron ? `on a schedule: ${sched.cron}` : 'manually'} help="Manual workflows run when someone starts them. A schedule starts a run of the published version by itself." />
          {d.schedule ? <ConfigRow label="Next run" value={when(d.schedule.next_occurrence_at)} help={d.schedule.enabled ? undefined : 'The schedule is off.'} /> : null}
          {admin && d.hasPublished && d.schedulesLoaded ? <ScheduleForm key={d.slug} slug={d.slug} schema={d.def?.inputs} schedule={d.schedule} /> : <p className="muted small">{admin ? 'Publish a version before adding a schedule.' : 'Setting a schedule needs the admin role.'}</p>}
        </>
      );
    }
    case 'secrets': {
      const use = secretUse(d);
      const missing = missingSecrets(d);
      return (
        <>
          <p className="muted">Values are encrypted on the server and only resolved when a step needs them. Steps and agents never see them.</p>
          {use.size ? [...use].map(([name, steps]) => (
            <ConfigRow key={name} label={<span className="mono">{name}</span>} value={missing.has(name) ? 'missing' : 'set'} tone={missing.has(name) ? 'warn' : 'ok'} from={undefined}>
              <div className="cfg-from"><span className="muted small">used by</span>{steps.map((s) => <span key={s} className="chip-effect">{s}</span>)}</div>
            </ConfigRow>
          )) : <p className="muted">No step of this workflow uses a secret.</p>}
          {admin ? <p><Link to="/ui/secrets">Set or replace secrets</Link></p> : <p className="muted small">Setting a secret needs the admin role.</p>}
        </>
      );
    }
    case 'connections':
      return <Connections d={d} admin={admin} />;
    case 'datasets': {
      const sets = datasetsUsed(d.nodes);
      return (
        <>
          <p className="muted">Knowledge that agent and retrieve steps read. A name like <span className="mono">guidelines@approved</span> follows the tag, so publishing a new revision changes nothing until the tag moves.</p>
          {sets.size ? [...sets].map(([ref, steps]) => {
            const name = ref.split('@')[0]!;
            return <ConfigRow key={ref} label={<Link to={`/ui/datasets/${encodeURIComponent(name)}`} className="mono">{name}</Link>} value={ref.includes('@') ? `follows the ${ref.split('@')[1]} tag` : 'latest revision'}><div className="cfg-from"><span className="muted small">read by</span>{steps.map((s) => <span key={s} className="chip-effect">{s}</span>)}</div></ConfigRow>;
          }) : <p className="muted">No step of this workflow reads a dataset.</p>}
        </>
      );
    }
    case 'limits': {
      const rows = d.nodes.filter((n) => n.def?.timeout || n.def?.budget || n.def?.retry || n.def?.limits);
      return (
        <>
          <p className="muted">Timeouts, budgets and retries stop a step that runs too long or costs too much. The run records why a step stopped.</p>
          {rows.length ? (
            <Table head={['Step', 'Timeout', 'Budget', 'Retry']}>
              {rows.map((n) => {
                const b = (n.def?.budget ?? n.def?.limits) as Record<string, unknown> | undefined;
                const tries = (n.def?.retry as Record<string, unknown> | undefined)?.max_attempts;
                return <tr key={n.id}><td className="mono">{n.id}</td><td>{String(n.def?.timeout ?? '—')}</td><td>{b ? Object.entries(b).map(([k, v]) => `${k.replaceAll('_', ' ')}: ${String(v)}`).join(', ') : '—'}</td><td>{typeof tries === 'number' ? `up to ${tries}` : '—'}</td></tr>;
              })}
            </Table>
          ) : <p className="muted">No step sets a limit, so the defaults apply.</p>}
        </>
      );
    }
    case 'assets':
      return <PortableAssets slug={d.slug} assets={d.assets} />;
    case 'files':
      return (
        <>
          <ConfigRow label="Version" value={<>v{d.version.version} {d.version.draft ? <Badge tone="idle">draft</Badge> : <Badge tone="ok">published</Badge>}</>} />
          <ConfigRow label="Signature" value={d.plan ? (d.plan.signer.verified ? `verified, ${d.plan.signer.publisher}` : `not verified${d.plan.signer.error ? `: ${d.plan.signer.error}` : ''}`) : '…'} help="Workers run signed packages only." />
          <ConfigRow label="Uploaded" value={when(d.version.created_at)} />
          <ConfigRow label="Package" value={<span className="mono">{d.version.package_hash.slice(0, 19)}</span>} />
          {d.version.draft ? <p className={author ? 'muted' : 'warn-note'}>This version is a draft. {author ? 'Sign and publish it from the buttons at the top of the page.' : 'An author publishes it.'}</p> : null}
          <h3 className="section">Files in this version</h3>
          <WorkflowFiles versionId={d.version.id} />
          <p className="small"><button type="button" className="linkish" onClick={onClose}>Close</button></p>
        </>
      );
  }
}

/**
 * The tools the workflow calls and the repositories its GitHub tools may use. A repository added
 * here is checked straight away against each tool's token, so a token that lacks access (or the
 * scope the tool needs) is reported before a run fails on it.
 */
function Connections({ d, admin }: { d: SettingsData; admin: boolean }) {
  const qc = useQueryClient();
  const byRef = new Map<string, string[]>();
  for (const n of d.nodes) if (n.type === 'tool' && typeof n.def?.tool === 'string') byRef.set(n.def.tool, [...(byRef.get(n.def.tool) ?? []), n.id]);
  const rows = [...byRef].map(([ref, steps]) => ({ ref, steps, tool: toolOf(d.tools, ref) }));
  const gh = rows.filter((r) => Array.isArray(r.tool?.transport?.config?.repos));
  const refs = gh.map((r) => r.ref);
  const repos = [...new Map(gh.flatMap((r) => r.tool!.transport!.config!.repos!).map((x) => [x.toLowerCase(), x])).values()];
  const secrets = missingSecrets(d);
  return (
    <>
      <p className="muted">Every external call goes through the gateway as one of these tools. Writes are recorded in each run's action ledger.</p>
      {rows.length ? (
        <Table head={['Tool', 'Effect', 'Token', 'Used by']}>
          {rows.map(({ ref, steps, tool: t }) => (
            <tr key={ref}>
              <td><span className="mono">{ref}</span>{t?.description ? <div className="muted small">{t.description}</div> : null}</td>
              <td>{t ? <Badge tone={t.effect === 'read' ? 'ok' : t.effect === 'write-unsafe' ? 'bad' : 'warn'}>{t.effect}</Badge> : <Badge tone="bad">not registered</Badge>}</td>
              <td>{t?.credential ? <><span className="mono small">{t.credential}</span> <Badge tone={secrets.has(t.credential) ? 'bad' : 'ok'}>{secrets.has(t.credential) ? 'missing' : 'set'}</Badge></> : <span className="muted">none</span>}</td>
              <td>{steps.join(', ')}</td>
            </tr>
          ))}
        </Table>
      ) : <p className="muted">No step of this workflow calls a tool.</p>}
      {gh.length ? (
        <div className="sd-group">
          <h3>Allowed repositories</h3>
          <p className="muted small">The GitHub tools above refuse any other repository. To use this workflow on another one, add it here: no reinstall from the templates is needed.</p>
          <RepoList
            refs={refs}
            repos={repos}
            canEdit={admin}
            change={async (c) => {
              for (const ref of refs) await api(`/v1/tools/${encodeURIComponent(ref)}/repos`, { method: 'POST', body: c });
            }}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ['tools'] });
              void qc.invalidateQueries({ queryKey: ['plan'] });
            }}
          />
          {admin ? null : <p className="muted small">Changing repositories needs the admin role.</p>}
        </div>
      ) : null}
      <p><Link to="/ui/tools">All tools</Link></p>
    </>
  );
}

export function PortableAssets({ slug, assets }: { slug: string; assets?: PortableAsset[] }) {
  const [error, setError] = useState<string>();
  const download = async () => {
    try {
      const bundle = await api<{ files: Record<string, string> }>(`/v1/workflows/${encodeURIComponent(slug)}/opencode-export`);
      const blob = new Blob([JSON.stringify(bundle.files, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${slug}-opencode-assets.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <p className="muted">MCP servers, agents, skills and commands published once and attached to this workflow.</p>
      {!assets ? <Loading /> : assets.length ? (
        <>
          <div className="asset-attached">{assets.map((a) => <span className="badge" key={a.id}>{a.kind}: {a.name} <span className="mono">v{a.version}</span></span>)}</div>
          <p><button type="button" onClick={download}>Download OpenCode bundle</button></p>
        </>
      ) : <p className="muted">No portable assets are attached. Add published ones from the <Link to="/ui/assets">Library</Link>.</p>}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
