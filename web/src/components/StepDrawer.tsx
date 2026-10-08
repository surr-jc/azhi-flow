import { useState, type ReactNode } from 'react';
import { stringify } from 'yaml';
import type { RunPlan } from '../api';
import { Badge, Json, StateBadge } from '../ui';
import { brief, effectsOf, helpFor, keySettings, sentenceOf, sourcesOf, type ToolInfo } from '../stepHelp';
import { ConfigRow } from './ConfigRow';
import { Formatted } from './Rich';
import { TYPE, type NodeRunState, type PlanNode } from './WorkflowCanvas';

type Tab = 'overview' | 'settings' | 'data' | 'run';
const SKIP = new Set(['id', 'type', 'description', 'depends_on']);
const labelOf = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replaceAll('_', ' ');
const INPUT_KEYS = ['input', 'arguments', 'query', 'for_each', 'payload', 'message', 'destination'];

/**
 * What the workflow page shows for one selected step: what it does, every setting with its
 * meaning, where its data comes from and goes, and what happened the last time it ran.
 */
export function StepPanel({ node, nodes, tools, plan, run, runLabel, onPick, onClose, onExpand }: {
  node: PlanNode;
  nodes: PlanNode[];
  tools: ToolInfo[];
  plan?: RunPlan | null;
  /** The step's state in the workflow's latest run. */
  run?: NodeRunState;
  runLabel?: string;
  onPick: (id: string) => void;
  onClose: () => void;
  /** Given, the panel offers to open itself larger. */
  onExpand?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('settings');
  const def = node.def ?? {};
  const step = { type: node.type, ...def };
  const t = TYPE[node.type] ?? { glyph: '•', label: node.type };
  const ids = nodes.map((n) => n.id);
  const effects = effectsOf(step, tools);
  const np = plan?.nodes.find((n) => n.id === node.id);
  const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['settings', 'Settings'], ['data', 'Data'], ['run', 'Last run']];
  return (
    <section className="step-drawer" aria-label={`Step ${node.id}`}>
      <header className="sd-head">
        <div className="sd-title">
          <span className={`wf-glyph t-${node.type}`} aria-hidden="true">{t.glyph}</span>
          <h2 className="mono">{node.id}</h2>
          <Badge>{t.label}</Badge>
          {effects.map((e) => <span key={e.label} className={`chip-effect ${e.tone}`}>{e.label}</span>)}
          <span className="sd-actions">
            {onExpand ? <button type="button" className="small" onClick={onExpand} aria-label="Open larger" title="Open larger">⤢</button> : null}
            <button type="button" className="small" onClick={onClose} aria-label="Close step">✕</button>
          </span>
        </div>
        <p className="ed-sentence">{sentenceOf(step, tools, node.deps)}</p>
      </header>
      <div className="sd-tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div className="sd-body" role="tabpanel">
        {tab === 'overview' ? <Overview node={node} step={step} np={np} onPick={onPick} /> : null}
        {tab === 'settings' ? <Settings step={step} tools={tools} ids={ids} onPick={onPick} /> : null}
        {tab === 'data' ? <DataTab node={node} nodes={nodes} onPick={onPick} /> : null}
        {tab === 'run' ? <RunTab run={run} label={runLabel} /> : null}
      </div>
    </section>
  );
}

function Overview({ node, step, np, onPick }: { node: PlanNode; step: Record<string, any>; np?: NonNullable<RunPlan['nodes']>[number]; onPick: (id: string) => void }) {
  return (
    <>
      {step.description ? <p>{step.description}</p> : <p className="muted">This step has no description.</p>}
      <ConfigRow label="Runs after" value={node.deps.length ? undefined : 'the start of the run'} help="Steps that must finish before this one starts.">
        {node.deps.length ? <div className="cfg-from">{node.deps.map((d) => <button key={d} type="button" className="chip-link" onClick={() => onPick(d)}>{d}</button>)}</div> : null}
      </ConfigRow>
      {node.route ? <ConfigRow label="Only on route" value={`${node.route.route} of ${node.route.condition}`} help="This step is skipped when the condition picks another route." /> : null}
      {np && (np.coverage.length || np.requirements.length || np.tainted) ? (
        <div className="sd-group">
          <h3>Run plan for this step</h3>
          <div className="wf-plan">
            {np.tainted ? <div><Badge tone="warn">tainted</Badge> It reads untrusted data, so its writes are limited.</div> : null}
            {np.coverage.map((c, i) => <div key={`c${i}`}><Badge tone={c.enforcement === 'enforced' ? 'ok' : c.enforcement === 'harness' ? 'warn' : 'bad'}>{c.enforcement}</Badge> {c.action}: <span className="muted">{c.detail}</span></div>)}
            {np.requirements.map((r, i) => <div key={`r${i}`}><Badge tone={r.mark === 'native' ? 'ok' : r.mark === 'unsupported' ? 'bad' : 'warn'}>{r.mark}</Badge> {r.name}: <span className="muted">{r.detail}</span></div>)}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Settings({ step, tools, ids, onPick }: { step: Record<string, any>; tools: ToolInfo[]; ids: string[]; onPick: (id: string) => void }) {
  const rows = keySettings(step, tools);
  const covered = new Set(rows.flatMap((r) => r.keys));
  const rest = Object.entries(step).filter(([k, v]) => !SKIP.has(k) && k !== 'type' && v !== undefined && !covered.has(k));
  const from = (keys: string[]) => (keys.some((k) => INPUT_KEYS.includes(k)) ? sourcesOf(keys.map((k) => step[k])) : []);
  return (
    <>
      {rows.map((r) => (
        <ConfigRow key={r.label} label={r.label} value={r.label === 'Gets' && from(r.keys).length ? undefined : r.value} tone={r.tone} help={r.label === 'Effect' ? undefined : helpFor(step.type, r.keys[0]!)} from={r.label === 'Gets' ? from(r.keys) : undefined} steps={ids} onPick={onPick} />
      ))}
      {rest.length ? (
        <div className="sd-group">
          <h3>Other settings</h3>
          {rest.map(([k, v]) => (
            <ConfigRow key={k} label={labelOf(k)} help={helpFor(step.type, k)}>
              {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? <div className="cfg-val mono">{String(v)}</div> : <pre className="code">{stringify(v, { lineWidth: 0 }).trimEnd()}</pre>}
            </ConfigRow>
          ))}
        </div>
      ) : null}
      {!rows.length && !rest.length ? <p className="muted">No settings yet.</p> : null}
    </>
  );
}

function DataTab({ node, nodes, onPick }: { node: PlanNode; nodes: PlanNode[]; onPick: (id: string) => void }) {
  const def = node.def ?? {};
  const gets = sourcesOf(INPUT_KEYS.map((k) => def[k]));
  const feeds = nodes.filter((n) => n.deps.includes(node.id)).map((n) => n.id);
  const ids = nodes.map((n) => n.id);
  const schema = def.output_schema;
  return (
    <>
      <ConfigRow label="Gets" value={gets.length ? undefined : 'nothing from other steps'} help="Where this step's input comes from. A step sees only what is mapped in." from={gets} steps={ids} onPick={onPick} />
      <ConfigRow label="Returns" value={typeof schema === 'string' ? schema : schema ? 'inline schema' : brief(def.output) || 'its output'} help={schema ? 'The shape of this step\'s output. A reply that does not match fails the step.' : undefined} />
      <ConfigRow label="Feeds" value={feeds.length ? undefined : 'no later step'} help="Steps that read this step's output or run after it.">
        {feeds.length ? <div className="cfg-from">{feeds.map((d) => <button key={d} type="button" className="chip-link" onClick={() => onPick(d)}>{d}</button>)}</div> : null}
      </ConfigRow>
    </>
  );
}

function RunTab({ run, label }: { run?: NodeRunState; label?: string }): ReactNode {
  if (!run) return <p className="muted">{label ? `This step did not run in ${label}.` : 'This workflow has not run yet. Start a run to see what this step does.'}</p>;
  return (
    <>
      <ConfigRow label="Last run" value={label ?? ''}>
        <StateBadge state={run.state} />{run.attempts > 1 ? <span className="muted small"> {run.attempts} attempts</span> : null}
      </ConfigRow>
      {run.worker ? <ConfigRow label="Worker" value={<span className="mono">{run.worker}</span>} /> : null}
      {run.error ? <div className="sd-group"><h3>Error</h3><Json value={run.error} /></div> : run.output !== undefined && run.output !== null ? <div className="sd-group"><h3>Output</h3><Formatted value={run.output} /></div> : null}
    </>
  );
}
