import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RunPlan } from '../api';
import { Badge, Json, StateBadge } from '../ui';

/**
 * The workflow canvas (React Flow): a workflow's nodes laid out left to right in dependency
 * order, with approval gates and condition routes drawn as such. Given run details it shows each
 * node's live state. Read-only: nodes can be moved to look at the graph, but nothing is saved.
 */
export interface PlanNode {
  id: string;
  type: string;
  deps: string[];
  route?: { condition: string; route: string };
  def?: Record<string, any>;
}

export interface NodeRunState {
  state: string;
  attempts: number;
  output?: unknown;
  error?: unknown;
  worker?: string | null;
  route?: string;
}

const TYPE: Record<string, { glyph: string; label: string }> = {
  tool: { glyph: '⚙', label: 'Tool' },
  script: { glyph: '{ }', label: 'Script' },
  agent: { glyph: '✦', label: 'Agent' },
  retrieve: { glyph: '⌕', label: 'Retrieve' },
  condition: { glyph: '◇', label: 'Condition' },
  parallel: { glyph: '⫴', label: 'Parallel' },
  loop: { glyph: '↻', label: 'Loop' },
  subworkflow: { glyph: '⧉', label: 'Subworkflow' },
  approval: { glyph: '⛉', label: 'Approval gate' },
  report: { glyph: '▤', label: 'Report' },
  notify: { glyph: '➤', label: 'Notify' },
};

/** Run details (from GET /v1/runs/:id) to a state per node. */
export function nodeStates(detail: any): Record<string, NodeRunState> {
  const s: Record<string, NodeRunState> = {};
  for (const a of detail.attempts ?? []) {
    s[a.node_id] = { state: a.state, attempts: (s[a.node_id]?.attempts ?? 0) + 1, output: a.output, error: a.error, worker: a.worker_id };
  }
  for (const a of detail.approvals ?? []) {
    if (a.decision === null && s[a.node_id]?.state !== 'succeeded') s[a.node_id] = { ...(s[a.node_id] ?? { attempts: 0 }), state: 'waiting' };
  }
  return s;
}

/** Drops edges implied by longer paths, so the canvas shows the flow rather than every data ref. */
function reduce(nodes: PlanNode[]): Map<string, string[]> {
  const deps = new Map(nodes.map((n) => [n.id, new Set(n.deps)]));
  const reach = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const hit = reach.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    for (const d of deps.get(id) ?? []) {
      out.add(d);
      for (const x of ancestors(d)) out.add(x);
    }
    reach.set(id, out);
    return out;
  };
  const shown = new Map<string, string[]>();
  for (const n of nodes) {
    const direct = [...(deps.get(n.id) ?? [])];
    shown.set(n.id, direct.filter((d) => !direct.some((o) => o !== d && ancestors(o).has(d))));
  }
  return shown;
}

const W = 210;
const H = 78;
const GX = 70;
const GY = 26;

/** Longest-path layers, ordered within each layer by the average position of their parents. */
function layout(nodes: PlanNode[], shown: Map<string, string[]>) {
  const depth: Record<string, number> = {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const d = (id: string): number => (depth[id] ??= Math.max(-1, ...(byId.get(id)?.deps ?? []).map(d)) + 1);
  nodes.forEach((n) => d(n.id));
  const layers: string[][] = [];
  for (const n of nodes) (layers[depth[n.id]!] ??= []).push(n.id);
  const row: Record<string, number> = {};
  layers.forEach((ids, col) => {
    if (col > 0) {
      const score = (id: string) => {
        const ps = (shown.get(id) ?? []).map((p) => row[p]).filter((x): x is number => x !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
      };
      ids.sort((a, b) => score(a) - score(b));
    }
    ids.forEach((id, i) => (row[id] = i));
  });
  const tallest = Math.max(...layers.map((l) => l.length));
  const pos: Record<string, { x: number; y: number }> = {};
  layers.forEach((ids, col) => {
    const offset = ((tallest - ids.length) * (H + GY)) / 2;
    ids.forEach((id, i) => (pos[id] = { x: col * (W + GX), y: offset + i * (H + GY) }));
  });
  return pos;
}

type CardData = { node: PlanNode; run?: NodeRunState; live: boolean; selected: boolean };

function Card({ data }: NodeProps<Node<CardData>>) {
  const { node, run, live } = data;
  const t = TYPE[node.type] ?? { glyph: '•', label: node.type };
  const state = live ? (run?.state ?? 'pending') : undefined;
  const sub = node.type === 'agent' ? node.def?.profile : node.type === 'tool' ? node.def?.tool : node.type === 'approval' ? `role ${node.def?.role ?? 'operator'}` : node.type === 'condition' ? Object.keys(node.def?.routes ?? {}).join(' / ') : node.type === 'notify' ? node.def?.channel : node.type === 'script' ? node.def?.runtime : undefined;
  return (
    <div className={`wf-card t-${node.type} ${state ? `st-${state}` : ''}`} title={node.def?.description ?? `${node.id} (${t.label})`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="wf-head">
        <span className="wf-glyph" aria-hidden="true">{t.glyph}</span>
        <span className="wf-id">{node.id}</span>
      </div>
      <div className="wf-sub">
        <span>{t.label}{sub ? ` · ${sub}` : ''}</span>
      </div>
      {state ? (
        <div className="wf-state">
          <StateBadge state={state} />
          {run && run.attempts > 1 ? <span className="muted small"> ×{run.attempts}</span> : null}
          {run?.route ? <span className="muted small"> → {run.route}</span> : null}
        </div>
      ) : node.def?.description ? (
        <div className="wf-desc">{node.def.description}</div>
      ) : null}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { card: Card };

export function WorkflowCanvas({ nodes: planNodes, detail, plan, height: fixed }: { nodes: PlanNode[]; detail?: any; plan?: RunPlan | null; height?: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const live = Boolean(detail);
  const states = useMemo(() => (detail ? nodeStates(detail) : {}), [detail]);
  const shown = useMemo(() => reduce(planNodes), [planNodes]);
  const pos = useMemo(() => layout(planNodes, shown), [planNodes, shown]);

  const nodes: Node<CardData>[] = planNodes.map((n) => ({
    id: n.id,
    type: 'card',
    position: pos[n.id]!,
    data: { node: n, run: states[n.id] ? { ...states[n.id]!, route: routeTaken(states[n.id]) } : undefined, live, selected: selected === n.id },
    selected: selected === n.id,
    width: W,
    height: H,
    ariaLabel: `${n.id}, ${TYPE[n.type]?.label ?? n.type}${live ? `, ${states[n.id]?.state ?? 'pending'}` : ''}`,
  }));

  const edges: Edge[] = planNodes.flatMap((n) =>
    (shown.get(n.id) ?? []).map((dep) => {
      const routed = n.route && n.route.condition === dep;
      const target = states[n.id]?.state;
      const source = states[dep]?.state;
      const taken = live && routed ? routeTaken(states[dep]) === n.route!.route : undefined;
      const cls = !live ? '' : target === 'running' || target === 'waiting' ? 'e-active' : source === 'succeeded' && target && target !== 'skipped' ? 'e-done' : target === 'skipped' || taken === false ? 'e-skipped' : '';
      return {
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        type: 'smoothstep',
        className: cls,
        animated: live && (target === 'running' || target === 'waiting'),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        ...(routed ? { label: n.route!.route, labelBgPadding: [6, 2] as [number, number], labelBgBorderRadius: 4, labelClassName: 'e-label', labelBgClassName: 'e-label-bg' } : {}),
      };
    }),
  );

  // Small graphs fit the canvas. A long pipeline would shrink until it is unreadable, so it opens
  // at a readable zoom centred on the step that is running or waiting (or the start), and the
  // rest is a pan or the fit-view button away.
  const box = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Node<CardData>, Edge>>(null);
  const focus = planNodes.find((n) => ['running', 'waiting'].includes(states[n.id]?.state ?? ''))?.id ?? planNodes.find((n) => states[n.id]?.state === 'failed')?.id;
  const frame = () => {
    const f = flow.current;
    const el = box.current;
    if (!f || !el) return;
    const xs = Object.values(pos).map((p) => p.x);
    const ys = Object.values(pos).map((p) => p.y);
    const gw = Math.max(...xs) + W;
    const gh = Math.max(...ys) + H;
    const fit = Math.min((el.clientWidth - 48) / gw, (el.clientHeight - 48) / gh, 1.1);
    if (fit >= 0.72) return void f.fitView({ padding: 0.12, maxZoom: 1.1 });
    const zoom = Math.max(0.72, Math.min(0.9, (el.clientHeight - 48) / gh));
    const at = focus ? pos[focus]! : { x: 0, y: gh / 2 - H / 2 };
    const x = focus ? el.clientWidth / 2 - (at.x + W / 2) * zoom : 24;
    void f.setViewport({ x: Math.min(24, x), y: el.clientHeight / 2 - (at.y + H / 2) * zoom, zoom });
  };
  const framedOn = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (framedOn.current === focus) return;
    framedOn.current = focus;
    frame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Tall enough for the graph's widest layer at a readable zoom, and no taller.
  const height = fixed ?? Math.round(Math.min(560, Math.max(260, (Math.max(...Object.values(pos).map((p) => p.y)) + H) * 0.85 + 110)));

  const sel = planNodes.find((n) => n.id === selected);
  return (
    <div className="wf">
      <div className="wf-canvas" style={{ height }} ref={box}>
        <ReactFlow
          onInit={(f) => {
            flow.current = f;
            framedOn.current = focus;
            frame();
          }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          minZoom={0.2}
          maxZoom={1.6}
          nodesConnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_e, n) => setSelected((s) => (s === n.id ? null : n.id))}
          onPaneClick={() => setSelected(null)}
          aria-label="Workflow graph"
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} position="top-right" orientation="horizontal" />
        </ReactFlow>
      </div>
      <Legend live={live} />
      {sel ? <NodeDetails node={sel} run={states[sel.id]} plan={plan} onClose={() => setSelected(null)} /> : <p className="muted small">Select a node to see its details.</p>}
    </div>
  );
}

const routeTaken = (s?: NodeRunState) => (s?.state === 'succeeded' && typeof s.output === 'string' ? s.output : (s?.output as { route?: string } | undefined)?.route);

function Legend({ live }: { live: boolean }) {
  const items: Array<[string, ReactNode]> = live
    ? [['st-succeeded', 'succeeded'], ['st-running', 'running'], ['st-waiting', 'waiting for a person'], ['st-failed', 'failed'], ['st-skipped', 'skipped'], ['st-pending', 'not started']]
    : [['t-agent', 'agent'], ['t-approval', 'approval gate'], ['t-condition', 'condition'], ['t-tool', 'tool or script'], ['t-notify', 'notify (writes)']];
  return (
    <div className="wf-legend" aria-label="Legend">
      {items.map(([cls, label]) => <span key={cls}><i className={`sw ${cls}`} />{label}</span>)}
    </div>
  );
}

function NodeDetails({ node, run, plan, onClose }: { node: PlanNode; run?: NodeRunState; plan?: RunPlan | null; onClose: () => void }) {
  const np = plan?.nodes.find((n) => n.id === node.id);
  const def = node.def ?? {};
  return (
    <section className="panel wf-details" aria-label={`Node ${node.id}`}>
      <header className="panel-head">
        <h2>
          <span aria-hidden="true">{TYPE[node.type]?.glyph} </span>
          {node.id} <span className="muted small">{TYPE[node.type]?.label ?? node.type}</span>
        </h2>
        <button className="small" onClick={onClose}>Close</button>
      </header>
      {def.description ? <p>{def.description}</p> : null}
      <div className="meta tight">
        {run ? <div><span>State</span><StateBadge state={run.state} />{run.attempts > 1 ? ` ${run.attempts} attempts` : ''}</div> : null}
        <div><span>Runs after</span>{node.deps.length ? node.deps.join(', ') : 'start'}</div>
        {node.route ? <div><span>Only on route</span>{node.route.route} of {node.route.condition}</div> : null}
        {def.profile ? <div><span>Profile</span>{def.profile}{def.executor ? ` on ${def.executor}` : ''}</div> : null}
        {def.tool ? <div><span>Tool</span><span className="mono">{def.tool}</span></div> : null}
        {node.type === 'approval' ? <div><span>Decided by</span>role {def.role ?? 'operator'} or higher{def.expires_in ? `, expires after ${def.expires_in}` : ''}</div> : null}
        {def.guard ? <div><span>Guard</span><span className="mono">{def.guard}</span></div> : null}
        {np?.tainted ? <div><span>Taint</span><Badge tone="warn">tainted</Badge></div> : null}
      </div>
      {node.type === 'condition' ? <p className="mono small">{def.expression}</p> : null}
      {np && (np.coverage.length || np.requirements.length) ? (
        <div className="wf-plan">
          {np.coverage.map((c, i) => <div key={`c${i}`}><Badge tone={c.enforcement === 'enforced' ? 'ok' : c.enforcement === 'harness' ? 'warn' : 'bad'}>{c.enforcement}</Badge> {c.action}: <span className="muted">{c.detail}</span></div>)}
          {np.requirements.map((r, i) => <div key={`r${i}`}><Badge tone={r.mark === 'native' ? 'ok' : r.mark === 'unsupported' ? 'bad' : 'warn'}>{r.mark}</Badge> {r.name}: <span className="muted">{r.detail}</span></div>)}
        </div>
      ) : null}
      {run?.error ? <><h3 className="small">Error</h3><Json value={run.error} /></> : run?.output !== undefined && run.output !== null ? <details><summary>Output</summary><Json value={run.output} /></details> : null}
    </section>
  );
}
