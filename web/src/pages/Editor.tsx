import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parse, stringify } from 'yaml';
import { api, atLeast, type RunPlan } from '../api';
import { useMe } from '../App';
import { TYPE, WorkflowCanvas, type PlanNode } from '../components/WorkflowCanvas';
import { Link, useRoute } from '../router';
import { Badge, ErrorNote, Loading, PageHead, Panel } from '../ui';
import { Coverage } from './Run';

/**
 * The workflow editor: add, connect, change and remove steps on the canvas, checked as you go by
 * the server's compiler and run plan, and saved as a new draft version of the same workflow
 * through the normal package upload. The other files of the package (profiles, schemas,
 * templates, scripts) are kept as they are. Publishing still needs a publisher signature.
 */
type Step = Record<string, any> & { id: string; type: string };
type Definition = Record<string, any> & { id: string; nodes: Step[] };
interface Diagnostic { severity: 'error' | 'warning' | 'info'; code: string; message: string; node?: string; path?: string }
interface Check { ok: boolean; diagnostics: Diagnostic[]; yaml?: string; plan?: RunPlan }
interface Source { workflow: string; files: Array<{ path: string; size: number; text?: string }> }
interface Tool { id: string; version: number; description: string; effect: string }

const STEP_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ADDABLE = ['tool', 'agent', 'script', 'retrieve', 'condition', 'approval', 'parallel', 'report', 'notify'];

type Field = { key: string; label: string; kind: 'text' | 'expr' | 'number' | 'list' | 'value' | 'select'; options?: string[]; suggest?: 'tools' | 'profiles' | 'schemas' | 'files'; hint?: string };
const COMMON: Field[] = [
  { key: 'timeout', label: 'Timeout', kind: 'text', hint: 'For example 10m' },
  { key: 'retry', label: 'Retry', kind: 'value', hint: 'For example max_attempts: 3' },
];
const FIELDS: Record<string, Field[]> = {
  tool: [
    { key: 'tool', label: 'Tool', kind: 'text', suggest: 'tools' },
    { key: 'arguments', label: 'Arguments', kind: 'value' },
    { key: 'project', label: 'Keep only these output fields', kind: 'list' },
    { key: 'guard', label: 'Guard (CEL)', kind: 'expr' },
  ],
  agent: [
    { key: 'profile', label: 'Profile', kind: 'text', suggest: 'profiles' },
    { key: 'executor', label: 'Executor', kind: 'text', hint: 'Empty for the built-in model agent' },
    { key: 'input', label: 'Input', kind: 'value' },
    { key: 'output_schema', label: 'Output schema', kind: 'text', suggest: 'schemas' },
    { key: 'tools', label: 'Tools the agent may call', kind: 'list' },
    { key: 'datasets', label: 'Datasets', kind: 'list' },
    { key: 'budget', label: 'Budget', kind: 'value', hint: 'max_output_tokens, max_tool_calls, max_cost_usd' },
  ],
  script: [
    { key: 'runtime', label: 'Runtime', kind: 'select', options: ['python', 'bun'] },
    { key: 'entrypoint', label: 'Entrypoint', kind: 'text', suggest: 'files' },
    { key: 'input', label: 'Input', kind: 'value' },
    { key: 'output_schema', label: 'Output schema', kind: 'text', suggest: 'schemas' },
  ],
  retrieve: [
    { key: 'datasets', label: 'Datasets', kind: 'list' },
    { key: 'query', label: 'Query', kind: 'value' },
    { key: 'top_k', label: 'Results', kind: 'number' },
    { key: 'filters', label: 'Filters', kind: 'value' },
  ],
  condition: [
    { key: 'expression', label: 'Expression (CEL, returns a route name)', kind: 'expr' },
    { key: 'routes', label: 'Routes', kind: 'value', hint: 'route name: [steps that run only on it]' },
    { key: 'default', label: 'Default route', kind: 'text' },
  ],
  parallel: [
    { key: 'for_each', label: 'For each', kind: 'value' },
    { key: 'node', label: 'Step to run for each item', kind: 'value' },
    { key: 'max_concurrency', label: 'At most at once', kind: 'number' },
    { key: 'join', label: 'Finish when', kind: 'select', options: ['', 'all', 'any'] },
  ],
  approval: [
    { key: 'role', label: 'Decided by role (or higher)', kind: 'select', options: ['', 'operator', 'author', 'admin', 'owner'] },
    { key: 'message', label: 'Message', kind: 'value' },
    { key: 'payload', label: 'Shown to the approver', kind: 'value' },
    { key: 'decision_schema', label: 'Decision form (JSON schema)', kind: 'value' },
    { key: 'expires_in', label: 'Expires after', kind: 'text', hint: 'For example 24h' },
    { key: 'on_expiry', label: 'On expiry', kind: 'select', options: ['', 'fail', 'reject'] },
  ],
  report: [
    { key: 'template', label: 'Template', kind: 'text', suggest: 'files' },
    { key: 'format', label: 'Format', kind: 'select', options: ['', 'markdown', 'html', 'csv'] },
    { key: 'input', label: 'Input', kind: 'value' },
    { key: 'summary', label: 'Summary', kind: 'value' },
  ],
  notify: [
    { key: 'destination', label: 'Slack channel', kind: 'value' },
    { key: 'message', label: 'Message', kind: 'value' },
    { key: 'guard', label: 'Guard (CEL)', kind: 'expr' },
  ],
};

/** Settings a new step starts with: enough for the schema, to be filled in. */
function starter(type: string, ctx: { tools: string[]; profiles: string[]; schemas: string[] }): Record<string, unknown> {
  switch (type) {
    case 'tool': return { tool: ctx.tools[0] ?? 'tool-id@1' };
    case 'agent': return { profile: ctx.profiles[0] ?? 'profile@1', output_schema: ctx.schemas[0] ?? { type: 'object' } };
    case 'script': return { runtime: 'python', entrypoint: 'scripts/main.py' };
    case 'retrieve': return { datasets: ['docs'], query: { ref: 'inputs.query' } };
    case 'condition': return { expression: "'yes'", routes: { yes: [] } };
    case 'approval': return { role: 'operator', message: 'Approve this step?' };
    case 'parallel': return { for_each: { ref: 'inputs.items' }, node: { type: 'tool', tool: ctx.tools[0] ?? 'tool-id@1' } };
    case 'report': return { template: 'templates/report.md', format: 'markdown' };
    case 'notify': return { channel: 'slack', destination: { ref: 'config.channel' }, message: 'Done.' };
    default: return {};
  }
}

const NODE_REF = /nodes\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** The graph as the compiler will see it: depends_on, condition routes, and refs to other steps. */
export function graphOf(def: Definition): PlanNode[] {
  const ids = new Set(def.nodes.map((n) => n.id));
  const routeOf = new Map<string, { condition: string; route: string }>();
  for (const n of def.nodes) {
    if (n.type !== 'condition') continue;
    for (const [route, members] of Object.entries((n.routes ?? {}) as Record<string, unknown>)) {
      if (Array.isArray(members)) for (const m of members) if (typeof m === 'string' && !routeOf.has(m)) routeOf.set(m, { condition: n.id, route });
    }
  }
  return def.nodes.map((n) => {
    const deps = new Set<string>(Array.isArray(n.depends_on) ? n.depends_on : []);
    const route = routeOf.get(n.id);
    if (route) deps.add(route.condition);
    const { id: _id, depends_on: _d, routes: _r, ...rest } = n;
    for (const m of JSON.stringify(rest).matchAll(NODE_REF)) deps.add(m[1]!);
    return { id: n.id, type: n.type, deps: [...deps].filter((d) => d !== n.id && ids.has(d)), route, def: n };
  });
}

function upstream(nodes: PlanNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const walk = (x: string) => byId.get(x)?.deps.forEach((d) => !out.has(d) && (out.add(d), walk(d)));
  walk(id);
  return out;
}

/** Renames a step and every reference to it: depends_on, routes, refs and CEL. */
function renameStep(def: Definition, from: string, to: string): Definition {
  const swap = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(new RegExp(`nodes\\.${from}(?![A-Za-z0-9_])`, 'g'), `nodes.${to}`));
  return {
    ...def,
    nodes: def.nodes.map((n) => {
      const { id, type, depends_on, routes, ...rest } = n;
      const out: Step = { id: id === from ? to : id, type, ...(swap(rest) as object) };
      if (depends_on) out.depends_on = depends_on.map((d: string) => (d === from ? to : d));
      if (routes) out.routes = Object.fromEntries(Object.entries(routes as Record<string, string[]>).map(([k, ms]) => [k, Array.isArray(ms) ? ms.map((m) => (m === from ? to : m)) : ms]));
      return reorder(out);
    }),
  };
}

/** Keeps the usual key order (id, type, description, depends_on first) so the YAML reads well. */
function reorder(n: Step): Step {
  const { id, type, description, depends_on, ...rest } = n;
  return { id, type, ...(description !== undefined ? { description } : {}), ...(depends_on?.length ? { depends_on } : {}), ...rest };
}

export function WorkflowEditor({ slug }: { slug: string }) {
  const me = useMe();
  const { search, navigate } = useRoute();
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ['versions', slug], queryFn: () => api<Array<{ id: string; version: number; draft: boolean }>>(`/v1/workflows/${encodeURIComponent(slug)}/versions`) });
  const from = search.get('from') ?? versions.data?.[0]?.id;
  const base = useQuery({ queryKey: ['version', from], queryFn: () => api<any>(`/v1/versions/${from}`), enabled: Boolean(from), staleTime: Infinity });
  const source = useQuery({ queryKey: ['source', from], queryFn: () => api<Source>(`/v1/versions/${from}/source`), enabled: Boolean(from), staleTime: Infinity });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/v1/tools') });

  const [def, setDef] = useState<Definition>();
  const [past, setPast] = useState<Definition[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (base.data && !def) setDef(structuredClone(base.data.definition));
  }, [base.data, def]);

  const change = (next: Definition) => {
    setPast((p) => [...p.slice(-49), def!]);
    setDef(next);
  };
  const undo = () => {
    const prev = past.at(-1);
    if (!prev) return;
    setPast((p) => p.slice(0, -1));
    setDef(prev);
    setRevision((r) => r + 1);
    if (selected && !prev.nodes.some((n) => n.id === selected)) setSelected(null);
  };

  // The server checks the definition a moment after each change.
  const text = def ? JSON.stringify(def) : '';
  const [checked, setChecked] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setChecked(text), 400);
    return () => clearTimeout(t);
  }, [text]);
  const check = useQuery({
    queryKey: ['check', from, checked],
    queryFn: () => api<Check>(`/v1/versions/${from}/check`, { method: 'POST', body: { definition: JSON.parse(checked) } }),
    enabled: Boolean(from && checked),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const current = check.data && !check.isPlaceholderData && checked === text && !check.isFetching;

  const save = useMutation({
    mutationFn: () => api<{ ok: boolean; diagnostics: Diagnostic[]; version?: { id: string; version: number } }>(`/v1/versions/${from}/drafts`, { method: 'POST', body: { definition: def } }),
    onSuccess: (r) => {
      if (!r.ok || !r.version) return;
      void qc.invalidateQueries({ queryKey: ['versions', slug] });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/ui/workflows/${encodeURIComponent(slug)}?version=${encodeURIComponent(r.version.id)}`);
    },
  });

  const graph = useMemo(() => (def ? graphOf(def) : []), [def]);
  const files = source.data?.files.map((f) => f.path) ?? [];
  const suggestions = {
    tools: (tools.data ?? []).map((t) => `${t.id}@${t.version}`),
    profiles: files.filter((f) => /^profiles\/.+\.ya?ml$/.test(f)).map((f) => f.replace(/^profiles\//, '').replace(/\.ya?ml$/, '')),
    schemas: files.filter((f) => f.endsWith('.json')),
    files,
  };

  if (versions.error || base.error) return <ErrorNote error={versions.error ?? base.error} />;
  if (me.data && !atLeast(me.data.role, 'author')) return <p>Editing workflows needs the author role or higher. Your role is {me.data.role}.</p>;
  if (!def || !base.data) return <Loading />;

  const diagnostics = check.data?.diagnostics ?? [];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const problems: Record<string, number> = {};
  for (const d of errors) if (d.node) problems[d.node] = (problems[d.node] ?? 0) + 1;
  const dirty = past.length > 0 && JSON.stringify(def) !== JSON.stringify(base.data.definition);
  const step = def.nodes.find((n) => n.id === selected);

  const updateStep = (id: string, patch: (s: Step) => Step) => change({ ...def, nodes: def.nodes.map((n) => (n.id === id ? reorder(patch(n)) : n)) });
  const addStep = (type: string) => {
    let i = 1;
    while (def.nodes.some((n) => n.id === `${type}_${i}`)) i++;
    const id = `${type}_${i}`;
    const after = selected && def.nodes.some((n) => n.id === selected) ? [selected] : [];
    const n = reorder({ id, type, ...(after.length ? { depends_on: after } : {}), ...starter(type, suggestions) });
    change({ ...def, nodes: [...def.nodes, n] });
    setSelected(id);
  };
  const removeStep = (id: string) => {
    change({
      ...def,
      nodes: def.nodes
        .filter((n) => n.id !== id)
        .map((n) => {
          const out: Step = { ...n };
          if (out.depends_on) out.depends_on = out.depends_on.filter((d: string) => d !== id);
          if (out.routes) out.routes = Object.fromEntries(Object.entries(out.routes as Record<string, string[]>).map(([k, ms]) => [k, Array.isArray(ms) ? ms.filter((m) => m !== id) : ms]));
          return reorder(out);
        }),
    });
    setSelected(null);
  };
  const connect = (source: string, target: string) => {
    if (upstream(graph, source).has(target)) return; // would make a loop
    updateStep(target, (n) => ({ ...n, depends_on: [...new Set([...(n.depends_on ?? []), source])] }));
  };
  const disconnect = (source: string, target: string) => {
    const t = def.nodes.find((n) => n.id === target);
    const s = def.nodes.find((n) => n.id === source);
    if (!t) return;
    const next: Definition = {
      ...def,
      nodes: def.nodes.map((n) => {
        if (n.id === target && n.depends_on?.includes(source)) return reorder({ ...n, depends_on: n.depends_on.filter((d: string) => d !== source) });
        if (n.id === source && s?.type === 'condition' && n.routes) return { ...n, routes: Object.fromEntries(Object.entries(n.routes as Record<string, string[]>).map(([k, ms]) => [k, Array.isArray(ms) ? ms.filter((m) => m !== target) : ms])) };
        return n;
      }),
    };
    if (JSON.stringify(next) !== JSON.stringify(def)) change(next);
  };
  const stillLinked = step ? graphOf(def).find((n) => n.id === step.id)?.deps.filter((d) => !(step.depends_on ?? []).includes(d)) : [];

  return (
    <>
      <PageHead
        title={<>Edit {def.name ?? slug}</>}
        sub={<>From v{base.data.version}{base.data.draft ? ' (draft)' : ''}. Saving makes a new unsigned draft version; publish it with <code>azhi publish</code> once it is signed.</>}
        actions={
          <div className="row">
            <button type="button" onClick={undo} disabled={!past.length}>Undo</button>
            <Link to={`/ui/workflows/${encodeURIComponent(slug)}`} className="button">Close</Link>
            <button type="button" className="primary" disabled={!dirty || !current || !check.data?.ok || save.isPending} onClick={() => save.mutate()}>
              Save draft
            </button>
          </div>
        }
      />
      <ErrorNote error={save.error} />
      {save.data && !save.data.ok ? <div className="error" role="alert">Not saved: {save.data.diagnostics.map((d) => d.message).join('; ')}</div> : null}
      <div className="ed-palette" role="toolbar" aria-label="Add a step">
        <span className="muted small">Add a step{selected ? ` after ${selected}` : ''}:</span>
        {ADDABLE.map((t) => (
          <button key={t} type="button" className="small" onClick={() => addStep(t)} aria-label={`Add ${TYPE[t]?.label ?? t} step`}>
            <span aria-hidden="true">{TYPE[t]?.glyph} </span>{TYPE[t]?.label ?? t}
          </button>
        ))}
      </div>
      <div className="ed-grid">
        <div className="ed-canvas">
          <WorkflowCanvas nodes={graph} height={520} edit={{ selected, onSelect: setSelected, onConnect: connect, onDisconnect: disconnect, problems }} />
          <CheckSummary check={check.data} current={Boolean(current)} error={check.error} onPick={setSelected} />
        </div>
        <aside className="ed-side">
          {step ? (
            <StepForm
              key={`${step.id}/${revision}`}
              step={step}
              all={def.nodes.map((n) => n.id)}
              stillLinked={stillLinked ?? []}
              suggestions={suggestions}
              diagnostics={diagnostics.filter((d) => d.node === step.id)}
              onChange={(s) => updateStep(step.id, () => s)}
              onRename={(to) => {
                change(renameStep(def, step.id, to));
                setSelected(to);
              }}
              onRemove={() => removeStep(step.id)}
              onClose={() => setSelected(null)}
            />
          ) : (
            <WorkflowForm key={revision} def={def} onChange={change} />
          )}
        </aside>
      </div>
      <datalist id="ed-tools">{suggestions.tools.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="ed-profiles">{suggestions.profiles.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="ed-schemas">{suggestions.schemas.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="ed-files">{suggestions.files.map((t) => <option key={t} value={t} />)}</datalist>
      <h2 className="section">Run plan of this edit</h2>
      {check.data?.plan ? <Coverage plan={check.data.plan} note="This is the plan the edit would have now, as an unsigned draft, with the workers online now." /> : <p className="muted">The run plan shows once the workflow compiles.</p>}
      {check.data?.yaml ? (
        <details className="panel">
          <summary>Workflow file ({source.data?.workflow ?? 'workflow.yaml'})</summary>
          <pre className="code">{check.data.yaml}</pre>
        </details>
      ) : null}
    </>
  );
}

function CheckSummary({ check, current, error, onPick }: { check?: Check; current: boolean; error: unknown; onPick: (id: string) => void }) {
  if (error) return <ErrorNote error={error} />;
  if (!check) return <p className="muted small">Checking…</p>;
  const errors = check.diagnostics.filter((d) => d.severity === 'error');
  const warnings = check.diagnostics.filter((d) => d.severity !== 'error');
  return (
    <div className="ed-check" aria-live="polite" aria-label="Check">
      <p>
        {!current ? <span className="muted">Checking… </span> : null}
        {check.ok ? <Badge tone="ok">compiles</Badge> : <Badge tone="bad">{errors.length} problem{errors.length === 1 ? '' : 's'}</Badge>}{' '}
        {check.plan ? (check.plan.ok ? <Badge tone="ok">run plan has no blockers</Badge> : <Badge tone="warn">run plan has {check.plan.blockers.length} blocker(s)</Badge>) : null}
        {warnings.length ? <> <Badge tone="warn">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</Badge></> : null}
      </p>
      {check.diagnostics.length ? (
        <ul className="ed-diags">
          {check.diagnostics.map((d, i) => (
            <li key={i} className={d.severity}>
              {d.node ? <button type="button" className="linkish" onClick={() => onPick(d.node!)}>{d.node}</button> : <span className="muted">workflow</span>}: {d.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepForm({ step, all, stillLinked, suggestions, diagnostics, onChange, onRename, onRemove, onClose }: {
  step: Step;
  all: string[];
  stillLinked: string[];
  suggestions: Record<'tools' | 'profiles' | 'schemas' | 'files', string[]>;
  diagnostics: Diagnostic[];
  onChange: (s: Step) => void;
  onRename: (to: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(step.id);
  const idError = id === step.id ? undefined : !STEP_ID.test(id) ? 'Letters, digits and _ only, not starting with a digit.' : all.includes(id) ? 'Another step has this id.' : undefined;
  const set = (key: string, value: unknown) => {
    const next: Step = { ...step };
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const deps: string[] = step.depends_on ?? [];
  const t = TYPE[step.type];
  return (
    <section className="panel" aria-label={`Step ${step.id}`}>
      <header className="panel-head">
        <h2><span aria-hidden="true">{t?.glyph} </span>{step.id} <span className="muted small">{t?.label ?? step.type}</span></h2>
        <button type="button" className="small" onClick={onClose}>Done</button>
      </header>
      {diagnostics.some((d) => d.severity === 'error') ? <div className="error">{diagnostics.filter((d) => d.severity === 'error').map((d, i) => <div key={i}>{d.message}</div>)}</div> : null}
      {diagnostics.some((d) => d.severity !== 'error') ? <div className="warn-note">{diagnostics.filter((d) => d.severity !== 'error').map((d, i) => <div key={i}>{d.message}</div>)}</div> : null}
      <div className="form">
        <label>
          Step id
          <input value={id} onChange={(e) => setId(e.target.value)} onBlur={() => !idError && id !== step.id && onRename(id)} onKeyDown={(e) => e.key === 'Enter' && !idError && id !== step.id && onRename(id)} spellCheck={false} />
          {idError ? <span className="error small">{idError}</span> : id !== step.id ? <span className="muted small">References to it are renamed too.</span> : null}
        </label>
        <label>
          Description
          <input value={step.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </label>
        <div className="ed-deps">
          <span className="label">Runs after</span>
          <div className="row wrap">
            {deps.map((d) => (
              <span key={d} className="chip">{d} <button type="button" className="linkish" aria-label={`Stop running after ${d}`} onClick={() => set('depends_on', deps.filter((x) => x !== d))}>×</button></span>
            ))}
            <select aria-label="Run after" value="" onChange={(e) => e.target.value && set('depends_on', [...deps, e.target.value])}>
              <option value="">add…</option>
              {all.filter((x) => x !== step.id && !deps.includes(x)).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          {stillLinked.length ? <span className="muted small">Also after {stillLinked.join(', ')}, because it reads their output or is on their route.</span> : null}
        </div>
        {[...(FIELDS[step.type] ?? []), ...COMMON].map((f) => <FieldInput key={f.key} field={f} value={step[f.key]} onChange={(v) => set(f.key, v)} />)}
      </div>
      <div className="row">
        <button type="button" className="danger" onClick={onRemove}>Remove step</button>
      </div>
    </section>
  );
}

function FieldInput({ field: f, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const list = f.suggest ? `ed-${f.suggest}` : undefined;
  let input: ReactNode;
  if (f.kind === 'select') {
    input = (
      <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
        {f.options!.map((o) => <option key={o} value={o}>{o || 'default'}</option>)}
      </select>
    );
  } else if (f.kind === 'number') {
    input = <input type="number" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  } else if (f.kind === 'list') {
    return <ListInput field={f} value={value} onChange={onChange} />;
  } else if (f.kind === 'value' || (f.kind === 'text' && value !== undefined && typeof value !== 'string')) {
    return <ValueInput field={f} value={value} onChange={onChange} />;
  } else if (f.kind === 'expr') {
    input = <textarea className="mono" rows={2} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  } else {
    input = <input value={typeof value === 'string' ? value : ''} list={list} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }
  return (
    <label>
      {f.label}
      {input}
      {f.hint ? <span className="muted small">{f.hint}</span> : null}
    </label>
  );
}

function ListInput({ field: f, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(Array.isArray(value) ? value.join(', ') : '');
  return (
    <label>
      {f.label}
      <input
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean));
        }}
      />
      <span className="muted small">Separate with commas.</span>
    </label>
  );
}

/** A structured value (refs, CEL, maps, schemas) edited as YAML; it is applied once it parses. */
function ValueInput({ field: f, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? '' : stringify(value, { lineWidth: 0 }).trimEnd());
  const [error, setError] = useState<string>();
  return (
    <label>
      {f.label}
      <textarea
        className="mono"
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = e.target.value.trim() ? parse(e.target.value) : undefined;
            setError(undefined);
            onChange(v === null ? undefined : v);
          } catch (err) {
            setError((err as Error).message.split('\n')[0]);
          }
        }}
      />
      {error ? <span className="error small">Not applied: {error}</span> : f.hint ? <span className="muted small">{f.hint}</span> : <span className="muted small">YAML, for example {'{ref: inputs.team}'} or {'{cel: "nodes.a.output.count > 0"}'}</span>}
    </label>
  );
}

function WorkflowForm({ def, onChange }: { def: Definition; onChange: (d: Definition) => void }) {
  const set = (key: string, value: unknown) => {
    const next: Definition = { ...def };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };
  return (
    <section className="panel" aria-label="Workflow settings">
      <header className="panel-head"><h2>Workflow</h2></header>
      <p className="muted small">Select a step on the canvas to change it. The workflow id <span className="mono">{def.id}</span> stays the same.</p>
      <div className="form">
        <label>Name<input value={def.name ?? ''} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Description<textarea rows={3} value={def.description ?? ''} onChange={(e) => set('description', e.target.value)} /></label>
        <ValueInput field={{ key: 'trigger', label: 'Trigger', kind: 'value', hint: 'manual: true, or schedule: {cron, timezone}' }} value={def.trigger} onChange={(v) => set('trigger', v)} />
        <ValueInput field={{ key: 'inputs', label: 'Inputs (JSON schema)', kind: 'value' }} value={def.inputs} onChange={(v) => set('inputs', v)} />
        <ValueInput field={{ key: 'config', label: 'Config', kind: 'value' }} value={def.config} onChange={(v) => set('config', v)} />
      </div>
    </section>
  );
}
