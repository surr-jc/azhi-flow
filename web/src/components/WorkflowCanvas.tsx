import { Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RunPlan } from '../api';
import { stringify } from 'yaml';
import { Icon } from '../icons';
import { duration } from '../pages/Overview';
import { keySettings, type KeySetting } from '../stepHelp';
import { Badge, Json, money, StateBadge } from '../ui';
import { Formatted } from './Rich';

/**
 * The workflow canvas (React Flow): a workflow's nodes laid out left to right in dependency
 * order, with approval gates and condition routes drawn as such. Given run details it shows each
 * node's live state. Read-only unless `edit` is given: then steps are connected by dragging from
 * one card's right handle to another's left (the target then runs after the source), and a
 * selected edge is removed with Delete. The editor owns the definition; the canvas only reports.
 *
 * The canvas itself shows the graph and nothing else. Titles, status, controls, filters, the
 * legend and any step panel live in rails above and below it and in a column beside it, so no
 * heads-up display ever covers a step or a link.
 */
export interface PlanNode {
  id: string;
  type: string;
  deps: string[];
  route?: { condition: string; route: string };
  def?: Record<string, any>;
  /** Shared contexts the step takes input from, and the steps each one reads. */
  bundles?: Array<{ name: string; from: string[] }>;
}

export interface NodeRunState {
  state: string;
  attempts: number;
  output?: unknown;
  error?: unknown;
  worker?: string | null;
  route?: string;
}

export const TYPE: Record<string, { glyph: string; icon: string; label: string }> = {
  tool: { glyph: '⚙', icon: 'tool', label: 'Tool' },
  script: { glyph: '{ }', icon: 'script', label: 'Script' },
  agent: { glyph: '✦', icon: 'agent', label: 'Agent' },
  retrieve: { glyph: '⌕', icon: 'retrieve', label: 'Retrieve' },
  condition: { glyph: '◇', icon: 'condition', label: 'Condition' },
  parallel: { glyph: '⫴', icon: 'parallel', label: 'Parallel' },
  loop: { glyph: '↻', icon: 'loop', label: 'Loop' },
  subworkflow: { glyph: '⧉', icon: 'subworkflow', label: 'Subworkflow' },
  approval: { glyph: '⛉', icon: 'gate', label: 'Approval gate' },
  report: { glyph: '▤', icon: 'report', label: 'Report' },
  notify: { glyph: '➤', icon: 'notify', label: 'Notify' },
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

const W = 184;
const H = 116;
const GX = 86;
const GY = 30;

/** How much of each step's configuration the cards show. */
export type CardDetail = 'names' | 'key' | 'all';
const DETAIL_KEY = 'azhi.canvas.detail';
const LINKS_KEY = 'azhi.canvas.links';
const KEY_ROWS = 3;
const ROW_H = 18;
/** A setting on a card, marked when it differs from the saved version. */
export type CardSetting = KeySetting & { changed?: boolean };

/** Card size for a detail level: wider, and tall enough for the rows it shows. */
function cardSize(detail: CardDetail, rows: number) {
  if (detail === 'names') return { w: W, h: H };
  const n = detail === 'key' ? Math.min(KEY_ROWS, rows) : rows;
  return { w: 250, h: 72 + Math.max(1, n) * ROW_H };
}

/** Longest-path layers, ordered within each layer by the average position of their parents. */
function layout(nodes: PlanNode[], shown: Map<string, string[]>, W: number, H: number) {
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

type CardData = { size: { w: number; h: number }; rows?: CardSetting[]; chips?: Array<{ label: string; tone: string }>; node: PlanNode; run?: NodeRunState; live: boolean; selected: boolean; editing?: boolean; problems?: number };

export interface CanvasEdit {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (source: string, target: string) => void;
  /** Error count per step, from the compiler. */
  problems: Record<string, number>;
}

function Card({ data }: NodeProps<Node<CardData>>) {
  const { node, run, live, editing, problems, chips, rows, size } = data;
  const t = TYPE[node.type] ?? { glyph: '•', icon: 'step', label: node.type };
  const state = live ? (run?.state ?? 'pending') : undefined;
  const sub = node.type === 'agent' ? node.def?.profile : node.type === 'tool' ? node.def?.tool : node.type === 'approval' ? `role ${node.def?.role ?? 'operator'}` : node.type === 'condition' ? Object.keys(node.def?.routes ?? {}).join(' / ') : node.type === 'notify' ? node.def?.channel : node.type === 'script' ? node.def?.runtime : undefined;
  return (
    <div className={`wf-card t-${node.type} ${state ? `st-${state}` : ''} ${problems ? 'has-problem' : ''} ${rows ? 'with-rows' : ''}`} style={{ width: size.w, height: size.h }} title={node.def?.description ?? `${node.id} (${t.label})`}>
      <Handle type="target" position={Position.Left} isConnectable={Boolean(editing)} />
      {node.def?.guard ? <span className="wf-guard" title="Guarded write: allowed only where the guard expression says" aria-label="Guarded"><Icon name="lock" size={14} /></span> : null}
      <div className="wf-head">
        <span className="wf-glyph" aria-hidden="true"><Icon name={t.icon} size={rows ? 22 : 34} /></span>
        <span className="wf-id">{node.id}</span>
        {rows?.some((r) => r.changed) ? <span className="wf-changed" title="Changed since the saved version">changed</span> : null}
        {problems ? <span className="wf-problem" title={`${problems} problem(s)`}>{problems}</span> : null}
      </div>
      {rows ? (
        <dl className="wf-rows">
          {rows.length ? rows.map((r) => (
            <div key={r.label} className={r.changed ? 'changed' : undefined}>
              <dt>{r.label}</dt>
              <dd className={r.tone ? `tone-${r.tone}` : undefined}>{r.value}</dd>
            </div>
          )) : <div><dt>Settings</dt><dd>none yet</dd></div>}
        </dl>
      ) : state ? (
        <div className="wf-state">
          <StateBadge state={state} />
          {run && run.attempts > 1 ? <span className="muted small"> ×{run.attempts}</span> : null}
          {run?.route ? <span className="muted small"> → {run.route}</span> : null}
        </div>
      ) : chips?.length ? (
        <div className="wf-chips">{chips.map((c) => <span key={c.label} className={`chip-effect ${c.tone}`}>{c.label}</span>)}</div>
      ) : (
        <div className="wf-sub">{sub ?? t.label}</div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={Boolean(editing)} />
    </div>
  );
}

const nodeTypes = { card: Card };

/** Run states in the order the fullscreen progress bar draws them. */
const STATES = ['succeeded', 'failed', 'skipped', 'running', 'waiting', 'pending'] as const;
const STATE_LABEL: Record<string, string> = { succeeded: 'succeeded', failed: 'failed', skipped: 'skipped', running: 'running', waiting: 'waiting', pending: 'not started' };

export function WorkflowCanvas({ nodes: planNodes, detail, plan, height: fixed, edit, select, states: override, head, foot, aside, chips, settings, details, title, tag }: {
  /** Named in the fullscreen run header, where the page's own rails give way to the canvas's. */
  title?: string;
  /** A short label beside the title there, such as the version. */
  tag?: string;
  nodes: PlanNode[];
  detail?: any;
  plan?: RunPlan | null;
  height?: number | string;
  edit?: CanvasEdit;
  /** Read-only, with the selected step owned by the page (which shows its details itself). */
  select?: { selected: string | null; onSelect: (id: string | null) => void };
  /** Node states to show instead of the run's current ones (a replay). */
  states?: Record<string, NodeRunState>;
  /** The rail above the canvas, before the view tools: title, status, modes. */
  head?: ReactNode;
  /** The rail below the canvas, before the legend: actions, checks, replay. */
  foot?: ReactNode;
  /** A column beside the canvas, such as the run's evidence. Fullscreen shows the step panel there instead. */
  aside?: ReactNode;
  /** Short labels under a step in the editor, such as what it changes outside Azhi. */
  chips?: (node: PlanNode) => Array<{ label: string; tone: string }>;
  /**
   * A step's key settings. Given, the cards can show them (Names, Key settings or All, chosen
   * above the canvas and remembered in this browser).
   */
  settings?: (node: PlanNode) => CardSetting[];
  /** The panel shown under the canvas for the selected step, in place of the built-in one. */
  details?: (node: PlanNode, close: () => void) => ReactNode;
}) {
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const owner = edit ?? select;
  const selected = owner ? owner.selected : ownSelected;
  const setSelected = (f: (s: string | null) => string | null) => (owner ? owner.onSelect(f(owner.selected)) : setOwnSelected(f));
  const [edgeSel, setEdgeSel] = useState<string | null>(null);
  const live = Boolean(detail);
  const current = useMemo(() => (detail ? nodeStates(detail) : {}), [detail]);
  const states = override ?? current;
  // While editing every direct dependency is drawn, so each one can be seen and removed.
  const reduced = useMemo(() => reduce(planNodes), [planNodes]);
  const [links, setLinks] = useState<'flow' | 'all'>(() => {
    try {
      return localStorage.getItem(LINKS_KEY) === 'all' ? 'all' : 'flow';
    } catch {
      return 'flow';
    }
  });
  const pickLinks = (v: 'flow' | 'all') => {
    setLinks(v);
    try {
      localStorage.setItem(LINKS_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  const allLinks = Boolean(edit) && links === 'all';
  const shown = useMemo(() => (allLinks ? new Map(planNodes.map((n) => [n.id, n.deps])) : reduced), [planNodes, reduced, allLinks]);
  const [level, setLevel] = useState<CardDetail>(() => {
    try {
      const v = localStorage.getItem(DETAIL_KEY);
      return v === 'key' || v === 'all' ? v : 'names';
    } catch {
      return 'names';
    }
  });
  const pickLevel = (v: CardDetail) => {
    setLevel(v);
    try {
      localStorage.setItem(DETAIL_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  const detailLevel: CardDetail = settings ? level : 'names';
  const rowsOf = useMemo(() => {
    const m = new Map<string, CardSetting[]>();
    if (settings && detailLevel !== 'names') for (const n of planNodes) m.set(n.id, settings(n));
    return m;
  }, [planNodes, settings, detailLevel]);
  const size = cardSize(detailLevel, Math.max(0, ...[...rowsOf.values()].map((r) => r.length)));
  const { w: W, h: H } = size;
  // Placement follows the reduced graph, so links implied by longer paths do not pull steps around.
  const pos = useMemo(() => layout(planNodes, reduced, W, H), [planNodes, reduced, W, H]);

  // Fullscreen: the browser's own where it allows it, else the canvas covering the window. The
  // page's rails give way to ones drawn from the graph and the run.
  const root = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState<'native' | 'overlay' | null>(null);
  const [spot, setSpot] = useState<{ by: 'type' | 'state'; value: string } | null>(null);
  useEffect(() => {
    const on = () => setFull((f) => (document.fullscreenElement && document.fullscreenElement === root.current ? 'native' : f === 'native' ? null : f));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => {
    if (full !== 'overlay') return;
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => void (document.body.style.overflow = was);
  }, [full]);
  const enter = () => {
    const el = root.current;
    if (!el) return;
    if (!el.requestFullscreen) return setFull('overlay');
    el.requestFullscreen().catch(() => setFull('overlay'));
    // Some embedded browsers neither grant nor refuse the request: cover the window instead.
    setTimeout(() => document.fullscreenElement !== el && setFull((f) => f ?? 'overlay'), 400);
  };
  const exit = () => {
    setSpot(null);
    if (full === 'native') void document.exitFullscreen().catch(() => setFull(null));
    else setFull(null);
  };
  const toggle = () => (full ? exit() : enter());
  const stateOf = (id: string) => (live ? (states[id]?.state ?? 'pending') : undefined);
  const lit = (n: PlanNode) => !spot || (spot.by === 'type' ? n.type === spot.value : stateOf(n.id) === spot.value);
  const pickSpot = (by: 'type' | 'state', value: string) => setSpot((s) => (s?.by === by && s.value === value ? null : { by, value }));
  // Arrow keys walk the steps in reading order: left to right, then top to bottom.
  const order = useMemo(() => [...planNodes].sort((a, b) => pos[a.id]!.x - pos[b.id]!.x || pos[a.id]!.y - pos[b.id]!.y).map((n) => n.id), [planNodes, pos]);
  const stepBy = (d: number) => {
    if (!order.length) return;
    const i = selected ? order.indexOf(selected) : -1;
    const next = i < 0 ? (d > 0 ? 0 : order.length - 1) : (i + d + order.length) % order.length;
    setSelected(() => order[next]!);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggle();
      } else if (!full) return;
      else if (e.key === 'Escape') {
        if (selected) setSelected(() => null);
        else if (full === 'overlay') exit();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // Taken before React Flow, which would otherwise nudge a focused step.
        e.preventDefault();
        e.stopPropagation();
        stepBy(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const run = detail?.run as { id: string; workflow: string; state: string; created_at: string; ended_at: string | null } | undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!full || !run || run.ended_at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [full, run]);

  const nodes: Node<CardData>[] = planNodes.map((n) => ({
    id: n.id,
    type: 'card',
    position: pos[n.id]!,
    data: { size, rows: rowsOf.has(n.id) ? (detailLevel === 'key' ? rowsOf.get(n.id)!.slice(0, KEY_ROWS) : rowsOf.get(n.id)) : undefined, node: n, run: states[n.id] ? { ...states[n.id]!, route: routeTaken(states[n.id]) } : undefined, live, selected: selected === n.id, editing: Boolean(edit), problems: edit?.problems[n.id], chips: chips?.(n) },
    selected: selected === n.id,
    ...(full && !lit(n) ? { className: 'dim' } : {}),
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
      // In fullscreen the selected step's links stand out, and links between dimmed steps fade.
      const near = full ? (selected && (dep === selected || n.id === selected) ? 'e-focus' : spot && !lit(n) && !lit(planNodes.find((x) => x.id === dep) ?? n) ? 'e-dim' : '') : '';
      const cls = !live ? '' : target === 'running' || target === 'waiting' ? 'e-active' : source === 'succeeded' && target && target !== 'skipped' ? 'e-done' : target === 'skipped' || taken === false ? 'e-skipped' : '';
      return {
        id: `${dep}->${n.id}`,
        selected: edgeSel === `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        type: 'default',
        className: [cls || (live ? '' : `es-${planNodes.find((x) => x.id === dep)?.type ?? 'tool'}`), edit && !reduced.get(n.id)?.includes(dep) ? 'e-redundant' : '', near].filter(Boolean).join(' '),
        // While editing, the direction of each link matters; a link implied by a longer path is drawn faint.
        ...(edit ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--idle)' } } : {}),
        animated: live && (target === 'running' || target === 'waiting'),
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
    const fit = Math.min((el.clientWidth - 48) / gw, (el.clientHeight - 48) / gh, 1.1);
    if (fit >= 0.5) return void f.fitView({ padding: 0.12, maxZoom: 1.1 });
    const zoom = Math.max(0.72, Math.min(0.9, (el.clientHeight - 48) / gh));
    const at = focus ? pos[focus]! : { x: 0, y: gh / 2 - H / 2 };
    const x = focus ? el.clientWidth / 2 - (at.x + W / 2) * zoom : 24;
    void f.setViewport({ x: Math.min(24, x), y: el.clientHeight / 2 - (at.y + H / 2) * zoom, zoom });
  };
  const framedOn = useRef<string | undefined>(undefined);
  useEffect(() => {
    frame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, H]);
  // Entering or leaving fullscreen resizes the canvas: frame the graph again once it has.
  useEffect(() => {
    // React Flow measures the new size a frame later.
    const id = setTimeout(frame, 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);
  useEffect(() => {
    if (framedOn.current === focus) return;
    framedOn.current = focus;
    frame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // While editing, a step that is selected (or just added) off screen is brought into view; in
  // fullscreen any selected step is.
  const watched = owner ? owner.selected : full ? selected : null;
  useEffect(() => {
    const f = flow.current;
    const el = box.current;
    const at = watched ? pos[watched] : undefined;
    if (!f || !el || !at) return;
    const { x, y, zoom } = f.getViewport();
    const sx = at.x * zoom + x;
    const sy = at.y * zoom + y;
    if (sx >= 0 && sy >= 0 && sx + W * zoom <= el.clientWidth && sy + H * zoom <= el.clientHeight) return;
    void f.setCenter(at.x + W / 2, at.y + H / 2, { zoom, duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, pos]);

  // Tall enough for the graph's widest layer at a readable zoom, and no taller.
  const height: number | string = fixed ?? Math.round(Math.min(settings ? 620 : 560, Math.max(260, (Math.max(0, ...Object.values(pos).map((p) => p.y)) + H) * 0.85 + 110)));

  const sel = planNodes.find((n) => n.id === selected);
  const typeCounts = countBy(planNodes, (n) => n.type);
  const stateCounts = live ? countBy(planNodes, (n) => stateOf(n.id)!) : {};
  const done = (stateCounts.succeeded ?? 0) + (stateCounts.failed ?? 0) + (stateCounts.skipped ?? 0);
  const usage = detail?.usage as { turns?: number; cost?: { amount: number | null; currency?: string } } | undefined;
  return (
    <div className={`wf${full ? ' is-full' : ''}${full === 'overlay' ? ' is-overlay' : ''}`} ref={root}>
      <div className="wf-rail wf-head">
        <div className="wf-slot">
          {full ? (
            <div className="wf-ident">
              <span className="wf-kicker">{live ? 'Run' : edit ? 'Editing' : 'Workflow'}</span>
              <span className="wf-name">{title ?? run?.workflow ?? 'Workflow'}</span>
              {tag ? <span className="pill">{tag}</span> : null}
              {run ? <><StateBadge state={run.state} /><span className="mono muted small">{run.id}</span></> : (
                <span className="muted small">
                  {planNodes.length} step{planNodes.length === 1 ? '' : 's'}
                  {typeCounts.agent ? ` · ${typeCounts.agent} agent${typeCounts.agent === 1 ? '' : 's'}` : ''}
                  {typeCounts.approval ? ` · ${typeCounts.approval} approval gate${typeCounts.approval === 1 ? '' : 's'}` : ''}
                </span>
              )}
            </div>
          ) : head}
        </div>
        {settings || edit ? (
          <div className="wf-detailbar">
            {settings ? (
              <>
                <span className="muted small">Show on cards</span>
                <div className="seg" role="group" aria-label="Show on cards">
                  {([['names', 'Names'], ['key', 'Key settings'], ['all', 'All settings']] as const).map(([v, label]) => (
                    <button key={v} type="button" aria-pressed={level === v} onClick={() => pickLevel(v)}>{label}</button>
                  ))}
                </div>
              </>
            ) : null}
            {edit ? (
              <>
                <span className="muted small">Links</span>
                <div className="seg" role="group" aria-label="Links shown">
                  {([['flow', 'Flow only'], ['all', 'All links']] as const).map(([v, label]) => (
                    <button key={v} type="button" aria-pressed={links === v} title={v === 'flow' ? 'Hide links already implied by a longer path (mostly data references)' : 'Show every direct dependency, so any can be removed'} onClick={() => pickLinks(v)}>{label}</button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="wf-view" role="toolbar" aria-label="View">
          <button type="button" className="wf-tool wf-zoom" onClick={() => void flow.current?.zoomOut({ duration: 150 })} title="Zoom out" aria-label="Zoom out"><Icon name="minus" size={18} /></button>
          <button type="button" className="wf-tool wf-zoom" onClick={() => void flow.current?.zoomIn({ duration: 150 })} title="Zoom in" aria-label="Zoom in"><Icon name="plus" size={18} /></button>
          <button type="button" className="wf-tool" onClick={frame} title="Fit the graph" aria-label="Fit the graph"><Icon name="fit" size={18} /></button>
          <button type="button" className="wf-tool" onClick={toggle} title={full ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} aria-label={full ? 'Exit fullscreen' : 'Show fullscreen'}>
            <Icon name={full ? 'shrink' : 'expand'} size={18} />
          </button>
        </div>
      </div>
      {full && live ? (
        <div className="wf-rail wf-progress">
          <div className="wf-stats">
            <div><span className="wf-kicker">Steps done</span><b>{done}<span className="muted">/{planNodes.length}</span></b></div>
            {run?.created_at ? <div><span className="wf-kicker">{run.ended_at ? 'Took' : 'Elapsed'}</span><b>{duration(run.created_at, run.ended_at ?? new Date(now).toISOString())}</b></div> : null}
            {usage?.turns ? <div><span className="wf-kicker">Model cost</span><b>{money(usage.cost?.amount ?? null, usage.cost?.currency)}</b></div> : null}
          </div>
          <div className="wf-bar" role="img" aria-label={STATES.filter((s) => stateCounts[s]).map((s) => `${stateCounts[s]} ${STATE_LABEL[s]}`).join(', ')}>
            {STATES.map((s) => (stateCounts[s] ? <i key={s} className={`b-${s}`} style={{ flexGrow: stateCounts[s] }} /> : null))}
          </div>
        </div>
      ) : null}
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
      <div className="wf-body" style={{ height }}>
        <div className="wf-canvas" ref={box}>
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
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
          </ReactFlow>
        </div>
        {full ? (sel ? <StepSide node={sel} run={states[sel.id]} live={live} onStep={stepBy} onClose={() => setSelected(() => null)} /> : null) : aside}
      </div>
      <div className="wf-rail wf-foot">
        {full ? (
          <>
            {live ? (
              <div className="wf-filters" role="group" aria-label="Highlight steps by state">
                {STATES.filter((s) => stateCounts[s]).map((s) => (
                  <button key={s} type="button" aria-pressed={spot?.by === 'state' && spot.value === s} onClick={() => pickSpot('state', s)}>
                    <i className={`sw st-${s}`} />{STATE_LABEL[s]}<b>{stateCounts[s]}</b>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="wf-filters wf-types" role="group" aria-label="Highlight steps by type">
              {Object.entries(typeCounts).map(([type, n]) => (
                <button key={type} type="button" className={`t-${type}`} aria-pressed={spot?.by === 'type' && spot.value === type} onClick={() => pickSpot('type', type)} title={`Highlight ${TYPE[type]?.label.toLowerCase() ?? type} steps`}>
                  <Icon name={TYPE[type]?.icon ?? 'step'} size={16} />{TYPE[type]?.label ?? type}<b>{n}</b>
                </button>
              ))}
            </div>
            <div className="wf-keys" aria-hidden="true">
              <span><kbd>←</kbd><kbd>→</kbd> step through</span>
              <span><kbd>F</kbd> exit</span>
            </div>
          </>
        ) : (
          <>
            {foot}
            {edit ? null : <Legend live={live} />}
          </>
        )}
      </div>
      {edit || select ? null : sel ? (details ? details(sel, () => setSelected(() => null)) : <NodeDetails node={sel} run={states[sel.id]} plan={plan} onClose={() => setSelected(() => null)} />) : <p className="muted small">Select a step to see its settings.</p>}
    </div>
  );
}

const routeTaken = (s?: NodeRunState) => (s?.state === 'succeeded' && typeof s.output === 'string' ? s.output : (s?.output as { route?: string } | undefined)?.route);

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/** The selected step in fullscreen, in a column beside the canvas: what it is, how it ran, and its key settings. */
function StepSide({ node, run, live, onStep, onClose }: { node: PlanNode; run?: NodeRunState; live: boolean; onStep: (d: number) => void; onClose: () => void }) {
  const t = TYPE[node.type] ?? { glyph: '•', icon: 'step', label: node.type };
  const def = node.def ?? {};
  const rows = keySettings({ type: node.type, ...def }, []);
  const route = routeTaken(run);
  const error = run?.error ? String((run.error as { message?: unknown }).message ?? JSON.stringify(run.error)) : null;
  return (
    <aside className="wf-side wf-step" aria-label={`Step ${node.id}`}>
      <header>
        <span className={`wf-tile t-${node.type}`} aria-hidden="true"><Icon name={t.icon} size={20} /></span>
        <div className="wf-step-name">
          <span className="wf-kicker">{t.label}</span>
          <h2>{node.id}</h2>
        </div>
        <button type="button" className="wf-x" onClick={onClose} aria-label="Close step" title="Close (Esc)"><Icon name="close" size={16} /></button>
      </header>
      {def.description ? <p className="wf-step-desc">{def.description}</p> : null}
      {live ? (
        <div className="wf-step-run">
          <StateBadge state={run?.state ?? 'pending'} />
          {run && run.attempts > 1 ? <span className="muted small">{run.attempts} attempts</span> : null}
          {route ? <span className="muted small">took route <b>{route}</b></span> : null}
          {run?.worker ? <span className="muted small mono" title="Worker">{run.worker}</span> : null}
        </div>
      ) : null}
      {error ? <p className="wf-step-err">{error}</p> : null}
      <dl className="wf-step-rows">
        <div><dt>Runs after</dt><dd>{node.deps.length ? node.deps.join(', ') : 'the start of the run'}</dd></div>
        {node.route ? <div><dt>Only on route</dt><dd>{node.route.route} of {node.route.condition}</dd></div> : null}
        {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd className={r.tone ? `tone-${r.tone}` : undefined} title={r.value}>{r.value}</dd></div>)}
      </dl>
      <footer>
        <button type="button" className="small" onClick={() => onStep(-1)}>← Previous step</button>
        <button type="button" className="small" onClick={() => onStep(1)}>Next step →</button>
      </footer>
    </aside>
  );
}

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

/** A setting key as a label: workflow files use snake_case. */
const labelOf = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replaceAll('_', ' ');
const SKIP = new Set(['id', 'type', 'description', 'depends_on']);

function NodeDetails({ node, run, plan, onClose }: { node: PlanNode; run?: NodeRunState; plan?: RunPlan | null; onClose: () => void }) {
  const np = plan?.nodes.find((n) => n.id === node.id);
  const def = node.def ?? {};
  const summary = keySettings({ type: node.type, ...def }, []);
  const raw = Object.entries(def).filter(([k, v]) => !SKIP.has(k) && v !== undefined);
  return (
    <section className="panel step-panel wf-details" aria-label={`Step ${node.id}`}>
      <header className="step-head">
        <h2><span className={`step-type t-${node.type}`}>{TYPE[node.type]?.label ?? node.type}</span>{node.id}</h2>
        {run ? <StateBadge state={run.state} /> : null}
        {run && run.attempts > 1 ? <span className="muted small">{run.attempts} attempts</span> : null}
        <div className="actions"><button type="button" className="small" onClick={onClose}>Close step</button></div>
        {def.description ? <p className="ed-sentence">{def.description}</p> : null}
      </header>
      {summary.length ? (
        <dl className="step-summary" aria-label="Key settings">
          {summary.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd className={r.tone ? `tone-${r.tone}` : undefined} title={r.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="step-body">
        <section className="set-group" aria-label="Settings">
          <h3>Settings</h3>
          <div className="set-row">
            <div className="set-label"><span className="name">Runs after</span></div>
            <div className="set-control set-value">{node.deps.length ? node.deps.join(', ') : 'the start of the run'}</div>
          </div>
          {node.route ? (
            <div className="set-row">
              <div className="set-label"><span className="name">Only on route</span></div>
              <div className="set-control set-value">{node.route.route} of {node.route.condition}</div>
            </div>
          ) : null}
          {raw.map(([k, v]) => (
            <div className="set-row" key={k}>
              <div className="set-label"><span className="name">{labelOf(k)}</span></div>
              <div className="set-control set-value">
                {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? <span className={typeof v === 'string' && /[.(=]/.test(v) ? 'mono' : undefined}>{String(v)}</span> : <pre className="code">{stringify(v, { lineWidth: 0 }).trimEnd()}</pre>}
              </div>
            </div>
          ))}
        </section>
        {np && (np.coverage.length || np.requirements.length || np.tainted) ? (
          <section className="set-group" aria-label="Run plan">
            <h3>Run plan</h3>
            <div className="wf-plan">
              {np.tainted ? <div><Badge tone="warn">tainted</Badge> It reads untrusted data, so its writes are limited.</div> : null}
              {np.coverage.map((c, i) => <div key={`c${i}`}><Badge tone={c.enforcement === 'enforced' ? 'ok' : c.enforcement === 'harness' ? 'warn' : 'bad'}>{c.enforcement}</Badge> {c.action}: <span className="muted">{c.detail}</span></div>)}
              {np.requirements.map((r, i) => <div key={`r${i}`}><Badge tone={r.mark === 'native' ? 'ok' : r.mark === 'unsupported' ? 'bad' : 'warn'}>{r.mark}</Badge> {r.name}: <span className="muted">{r.detail}</span></div>)}
            </div>
          </section>
        ) : null}
        {run?.error ? <section className="set-group"><h3>Error</h3><Json value={run.error} /></section> : run?.output !== undefined && run.output !== null ? <details><summary>Output</summary><Formatted value={run.output} /></details> : null}
      </div>
    </section>
  );
}
