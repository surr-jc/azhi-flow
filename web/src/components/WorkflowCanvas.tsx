import { Background, Controls, Handle, MarkerType, NodeToolbar, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RunPlan } from '../api';
import { Badge, Json, StateBadge } from '../ui';

/**
 * The workflow canvas (React Flow): a workflow's nodes laid out left to right in dependency
 * order, with approval gates and condition routes drawn as such. Given run details it shows each
 * node's live state. Read-only unless `edit` is given: then steps are connected by dragging from
 * one card's right handle to another's left (the target then runs after the source), and a
 * selected edge is removed with Delete. The editor owns the definition; the canvas only reports.
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

export const TYPE: Record<string, { glyph: string; label: string }> = {
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
  // A cycle (only possible mid-edit; the compiler rejects it) is cut where it is found.
  const visiting = new Set<string>();
  const d = (id: string): number => {
    if (depth[id] !== undefined) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const v = Math.max(-1, ...(byId.get(id)?.deps ?? []).filter((x) => byId.has(x)).map(d)) + 1;
    visiting.delete(id);
    return (depth[id] = v);
  };
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

type CardData = { chips?: Array<{ label: string; tone: string }>; node: PlanNode; run?: NodeRunState; live: boolean; selected: boolean; editing?: boolean; problems?: number; toolbar?: ReactNode };

export interface CanvasEdit {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (source: string, target: string) => void;
  /** Error count per step, from the compiler. */
  problems: Record<string, number>;
}

function Card({ data }: NodeProps<Node<CardData>>) {
  const { node, run, live, editing, problems, toolbar, chips } = data;
  const t = TYPE[node.type] ?? { glyph: '•', label: node.type };
  const state = live ? (run?.state ?? 'pending') : undefined;
  const sub = node.type === 'agent' ? node.def?.profile : node.type === 'tool' ? node.def?.tool : node.type === 'approval' ? `role ${node.def?.role ?? 'operator'}` : node.type === 'condition' ? Object.keys(node.def?.routes ?? {}).join(' / ') : node.type === 'notify' ? node.def?.channel : node.type === 'script' ? node.def?.runtime : undefined;
  return (
    <div className={`wf-card t-${node.type} ${state ? `st-${state}` : ''} ${problems ? 'has-problem' : ''}`} title={node.def?.description ?? `${node.id} (${t.label})`}>
      <Handle type="target" position={Position.Left} isConnectable={Boolean(editing)} />
      <div className="wf-head">
        <span className="wf-glyph" aria-hidden="true">{t.glyph}</span>
        <span className="wf-id">{node.id}</span>
        {problems ? <span className="wf-problem" title={`${problems} problem(s)`}>{problems}</span> : null}
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
      ) : chips?.length ? (
        <div className="wf-chips">{chips.map((c) => <span key={c.label} className={`chip-effect ${c.tone}`}>{c.label}</span>)}</div>
      ) : node.def?.description ? (
        <div className="wf-desc">{node.def.description}</div>
      ) : null}
      <Handle type="source" position={Position.Right} isConnectable={Boolean(editing)} />
      {toolbar ? <NodeToolbar isVisible position={Position.Bottom} offset={14} className="wf-toolbar">{toolbar}</NodeToolbar> : null}
    </div>
  );
}

const nodeTypes = { card: Card };

export function WorkflowCanvas({ nodes: planNodes, detail, plan, height: fixed, edit, states: override, toolbar, controls = 'top-right', inset, children, chips }: {
  nodes: PlanNode[];
  detail?: any;
  plan?: RunPlan | null;
  height?: number | string;
  edit?: CanvasEdit;
  /** Node states to show instead of the run's current ones (a replay). */
  states?: Record<string, NodeRunState>;
  /** Content pinned under one step, such as the decision on a waiting approval. */
  toolbar?: { node: string; content: ReactNode };
  controls?: 'top-right' | 'top-left';
  /** Short labels under a step in the editor, such as what it changes outside Azhi. */
  chips?: (node: PlanNode) => Array<{ label: string; tone: string }>;
  /** Pixels taken by panels floating over the canvas, kept clear when the graph is framed. */
  inset?: { right: number; bottom: number };
  /** Panels floating over the canvas. */
  children?: ReactNode;
}) {
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const selected = edit ? edit.selected : ownSelected;
  const setSelected = (f: (s: string | null) => string | null) => (edit ? edit.onSelect(f(edit.selected)) : setOwnSelected(f));
  const [edgeSel, setEdgeSel] = useState<string | null>(null);
  const live = Boolean(detail);
  const current = useMemo(() => (detail ? nodeStates(detail) : {}), [detail]);
  const states = override ?? current;
  // While editing every direct dependency is drawn, so each one can be seen and removed.
  const shown = useMemo(() => (edit ? new Map(planNodes.map((n) => [n.id, n.deps])) : reduce(planNodes)), [planNodes, Boolean(edit)]);
  const pos = useMemo(() => layout(planNodes, shown), [planNodes, shown]);

  const nodes: Node<CardData>[] = planNodes.map((n) => ({
    id: n.id,
    type: 'card',
    position: pos[n.id]!,
    data: { node: n, run: states[n.id] ? { ...states[n.id]!, route: routeTaken(states[n.id]) } : undefined, live, selected: selected === n.id, editing: Boolean(edit), problems: edit?.problems[n.id], chips: chips?.(n), toolbar: toolbar?.node === n.id ? toolbar.content : undefined },
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
        selected: edgeSel === `${dep}->${n.id}`,
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
    if (!planNodes.length) return;
    const xs = Object.values(pos).map((p) => p.x);
    const ys = Object.values(pos).map((p) => p.y);
    const gw = Math.max(...xs) + W;
    const gh = Math.max(...ys) + H;
    // Panels floating over the canvas take room the graph should not sit under (the right one
    // folds away on narrow canvases), and a pinned panel under a step needs room below it.
    const right = inset && el.clientWidth > 860 ? inset.right : 0;
    const bottom = (inset?.bottom ?? 0) + (toolbar ? 200 : 0);
    const fit = Math.min((el.clientWidth - right - 48) / gw, (el.clientHeight - bottom - 48) / gh, 1.1);
    if (fit >= 0.72) return void f.fitView({ padding: right || bottom ? { top: '24px', left: '24px', right: `${right + 24}px`, bottom: `${bottom + 24}px` } : 0.12, maxZoom: 1.1 });
    const zoom = Math.max(0.72, Math.min(0.9, (el.clientHeight - 48) / gh));
    const at = focus ? pos[focus]! : { x: 0, y: gh / 2 - H / 2 };
    const x = focus ? (el.clientWidth - right) / 2 - (at.x + W / 2) * zoom : 24;
    void f.setViewport({ x: Math.min(24, x), y: (el.clientHeight - bottom) / 2 - (at.y + H / 2) * zoom, zoom });
  };
  const framedOn = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (framedOn.current === focus) return;
    framedOn.current = focus;
    frame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // While editing, a step that is selected (or just added) off screen is brought into view.
  useEffect(() => {
    const f = flow.current;
    const el = box.current;
    const at = edit?.selected ? pos[edit.selected] : undefined;
    if (!f || !el || !at) return;
    const { x, y, zoom } = f.getViewport();
    const sx = at.x * zoom + x;
    const sy = at.y * zoom + y;
    if (sx >= 0 && sy >= 0 && sx + W * zoom <= el.clientWidth && sy + H * zoom <= el.clientHeight) return;
    void f.setCenter(at.x + W / 2, at.y + H / 2, { zoom, duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.selected, pos]);

  // Tall enough for the graph's widest layer at a readable zoom, and no taller.
  const height: number | string = fixed ?? Math.round(Math.min(560, Math.max(260, (Math.max(0, ...Object.values(pos).map((p) => p.y)) + H) * 0.85 + 110)));

  const sel = planNodes.find((n) => n.id === selected);
  return (
    <div className="wf">
      {edit ? (
        <div className="wf-edgebar" aria-live="polite">
          {edgeSel ? (
            <>
              <span>Link <b>{edgeSel.replace('->', ' → ')}</b></span>
              <button type="button" className="small" onClick={() => {
                const [a, b] = edgeSel.split('->') as [string, string];
                setEdgeSel(null);
                edit.onDisconnect(a, b);
              }}>Remove link</button>
            </>
          ) : <span className="muted">Drag from a step's right edge to another step to make it run after. Select a link to remove it.</span>}
        </div>
      ) : null}
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
          nodesConnectable={Boolean(edit)}
          edgesFocusable={Boolean(edit)}
          deleteKeyCode={edit ? ['Delete', 'Backspace'] : null}
          onConnect={(c) => edit && c.source && c.target && c.source !== c.target && edit.onConnect(c.source, c.target)}
          onEdgesDelete={(es) => {
            setEdgeSel(null);
            es.forEach((e) => edit?.onDisconnect(e.source, e.target));
          }}
          onNodesDelete={() => undefined}
          onBeforeDelete={async ({ edges }) => ({ nodes: [], edges })}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_e, n) => {
            setEdgeSel(null);
            setSelected((s) => (s === n.id && !edit ? null : n.id));
          }}
          onEdgeClick={(_e, e) => edit && setEdgeSel(e.id)}
          onPaneClick={() => {
            setEdgeSel(null);
            setSelected(() => null);
          }}
          aria-label="Workflow graph"
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} position={controls} orientation="horizontal" />
        </ReactFlow>
        {children}
      </div>
      {edit ? null : <Legend live={live} />}
      {edit ? null : sel ? <NodeDetails node={sel} run={states[sel.id]} plan={plan} onClose={() => setSelected(() => null)} /> : <p className="muted small">Select a node to see its details.</p>}
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
