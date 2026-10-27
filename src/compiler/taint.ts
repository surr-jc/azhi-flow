import type { Diagnostic } from '../definition/load.js';
import type { AgentNode, NotifyNode, ParallelNode, RetrieveNode, ToolNode } from '../definition/types.js';
import type { PlanNode } from './plan.js';

/**
 * Taint analysis (spec section 10, ADR-10).
 *
 * Untrusted data enters through tools whose output is not marked trusted (the default), and
 * through datasets marked untrusted. It flows along data edges through deterministic nodes
 * (scripts, reports, conditions). An agent node that receives untrusted data, or can call an
 * untrusted read tool, or retrieves from an untrusted dataset, is **tainted**: prompt injection can
 * steer it. Its output carries the taint downstream.
 *
 * A write (a notify node, a write tool node, or a tainted agent's own write tool) that tainted
 * output can reach must be gated by one of:
 *   1. an approval node on the path (it shows the concrete target and payload),
 *   2. a deterministic CEL guard declared on the write,
 *   3. a tool marked safe-for-tainted by an administrator.
 * The compiler rejects ungated paths; the run plan shows every path and its gate.
 */
export type Gate = 'approval' | 'guard' | 'safe_for_tainted';

export interface TaintPath {
  agent: string;
  write: string;
  path: string[];
  gate: Gate | null;
  /** For agent-internal writes: the tool the agent may call. */
  tool?: string;
}

export interface TaintReport {
  /** Nodes whose output contains untrusted data, with the reason. */
  untrusted: Record<string, string>;
  /** Tainted agent nodes, with why. */
  tainted: Record<string, string>;
  paths: TaintPath[];
}

export interface DatasetInfo {
  trusted: boolean;
}

export function analyseTaint(nodes: PlanNode[], datasets: (ref: string) => DatasetInfo | undefined = () => undefined): { report: TaintReport; diagnostics: Diagnostic[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.dataDeps) children.get(d)?.push(n.id);

  const untrusted: Record<string, string> = {};
  const tainted: Record<string, string> = {};
  // Nodes are in topological order, so upstream facts are known when we reach a node.
  for (const n of nodes) {
    const upstream = n.dataDeps.find((d) => untrusted[d]);
    if (n.type === 'tool' && n.tool && !n.tool.outputTrusted) untrusted[n.id] = `output of ${n.tool.ref} is not marked trusted`;
    else if ((n.type === 'parallel' || n.type === 'loop') && (n.def as ParallelNode).node.type === 'tool' && n.tool && !n.tool.outputTrusted) untrusted[n.id] = `output of ${n.tool.ref} is not marked trusted`;
    // A child run may call untrusted tools and agents the parent cannot see into, so what comes back is untrusted.
    else if (n.type === 'subworkflow') untrusted[n.id] = 'output of a subworkflow is not marked trusted';
    else if (n.type === 'retrieve') {
      const bad = (n.def as RetrieveNode).datasets.find((d) => datasets(d)?.trusted === false);
      if (bad) untrusted[n.id] = `dataset ${bad} is marked untrusted`;
    }
    if (n.type === 'agent') {
      const def = n.def as AgentNode;
      const reason =
        (def.workspace && 'reads a cloned repository (its files are untrusted)') ||
        (upstream && `reads ${upstream}, whose ${untrusted[upstream]}`) ||
        n.agentTools?.find((t) => t.effect === 'read' && !t.outputTrusted)?.ref.replace(/^/, 'can call untrusted read tool ') ||
        def.datasets?.find((d) => datasets(d)?.trusted === false)?.replace(/^/, 'retrieves from untrusted dataset ') ||
        n.dataDeps.find((d) => tainted[d])?.replace(/^/, 'reads output of tainted agent ');
      if (reason) {
        tainted[n.id] = reason;
        untrusted[n.id] = `output of tainted agent ${n.id}`;
      }
    } else if (!untrusted[n.id] && upstream && n.type !== 'approval') {
      untrusted[n.id] = untrusted[upstream]!.startsWith('output of tainted agent') ? untrusted[upstream]! : `derived from ${upstream}`;
    }
  }

  const isWrite = (n: PlanNode) =>
    n.type === 'notify' || ((n.type === 'tool' || n.type === 'parallel' || n.type === 'loop') && n.tool !== undefined && n.tool.effect !== 'read');
  const gateOf = (n: PlanNode): Gate | null => {
    const guard = n.type === 'notify' ? (n.def as NotifyNode).guard : n.type === 'tool' ? (n.def as ToolNode).guard : undefined;
    if (guard) return 'guard';
    if (n.tool?.safeForTainted) return 'safe_for_tainted';
    return null;
  };

  const paths: TaintPath[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const agentId of Object.keys(tainted)) {
    const agent = byId.get(agentId)!;
    for (const t of agent.agentTools ?? []) {
      if (t.effect === 'read') continue;
      const gate: Gate | null = t.safeForTainted ? 'safe_for_tainted' : null;
      paths.push({ agent: agentId, write: agentId, path: [agentId], gate, tool: t.ref });
      if (!gate) {
        diagnostics.push({
          severity: 'error',
          code: 'tainted_write_ungated',
          node: agentId,
          message: `tainted agent '${agentId}' (${tainted[agentId]}) may call write tool ${t.ref}, which is not marked safe-for-tainted`,
        });
      }
    }
    // Breadth-first over data edges; approval nodes stop the walk and gate everything after them.
    const prev = new Map<string, string>();
    const queue = [agentId];
    const viaApproval = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      for (const c of children.get(cur) ?? []) {
        if (prev.has(c)) continue;
        prev.set(c, cur);
        const node = byId.get(c)!;
        if (node.type === 'approval') {
          viaApproval.add(c);
          continue;
        }
        if (isWrite(node)) {
          const path = [c];
          for (let p = cur; p !== agentId; p = prev.get(p)!) path.unshift(p);
          path.unshift(agentId);
          const gate = gateOf(node);
          paths.push({ agent: agentId, write: c, path, gate });
          if (!gate) {
            diagnostics.push({
              severity: 'error',
              code: 'tainted_write_ungated',
              node: c,
              message: `write '${c}' can receive output of tainted agent '${agentId}' (${tainted[agentId]}) via ${path.join(' -> ')} with no approval, CEL guard or safe-for-tainted tool`,
            });
          }
        }
        if (node.type !== 'agent' || !tainted[node.id]) queue.push(c);
      }
    }
    // Writes behind an approval are gated: record them so the run plan can show the path.
    for (const a of viaApproval) {
      for (const w of reachableWrites(a, children, byId, isWrite)) paths.push({ agent: agentId, write: w, path: [agentId, '…', a, '…', w], gate: 'approval' });
    }
  }
  return { report: { untrusted, tainted, paths }, diagnostics };
}

function reachableWrites(from: string, children: Map<string, string[]>, byId: Map<string, PlanNode>, isWrite: (n: PlanNode) => boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(from) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    if (isWrite(byId.get(c)!)) out.push(c);
    stack.push(...(children.get(c) ?? []));
  }
  return out;
}
