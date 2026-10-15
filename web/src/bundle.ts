/** What a workflow template ships, as `/v1/examples` lists it (see src/api/bundle-inventory.ts). */
export interface BundleAgent { id: string; description: string | null; provider: string | null; model: string | null; skills: string[]; command: string | null; tools: string[]; mcp: string[]; steps: string[] }
export interface BundleSkill { id: string; description: string | null; agents: string[] }
export interface BundleCommand { id: string; description: string | null; agents: string[] }
export interface BundleMcp { name: string; command: string[]; env_names: string[]; agents: string[] }
export interface BundleHarnessTool { name: string; agents: string[] }
export interface BundleTool { ref: string; effect: string; description: string; transport?: string; roles?: string[] | null }
export interface Inventory {
  agents: BundleAgent[];
  skills: BundleSkill[];
  commands: BundleCommand[];
  mcp: BundleMcp[];
  harness_tools: BundleHarnessTool[];
  files: number;
}

export type BundleKind = 'agents' | 'skills' | 'commands' | 'mcp' | 'tools';
export const BUNDLE_KINDS: Array<{ id: BundleKind; label: string; one: string }> = [
  { id: 'agents', label: 'Agents', one: 'agent' },
  { id: 'skills', label: 'Skills', one: 'skill' },
  { id: 'commands', label: 'Commands', one: 'command' },
  { id: 'mcp', label: 'MCP servers', one: 'MCP server' },
  { id: 'tools', label: 'Tools', one: 'tool' },
];

/** One row per thing in the bundle, whatever its kind, so the grid and the side panel render them alike. */
export interface BundleItem {
  key: string;
  kind: BundleKind;
  title: string;
  summary: string | null;
  /** Small facts shown as chips on the card. */
  chips: Array<{ text: string; tone?: 'ok' | 'warn' }>;
  /** Labelled lists for the side panel; empty lists are left out. */
  groups: Array<{ label: string; values: string[] }>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Harness tools (read, grep...) and gateway tools share the Tools tab: the first are what an
 * agent may use inside its checkout, the second what the workflow may call through the gateway.
 */
export function bundleItems(inv: Inventory, gateway: BundleTool[]): Record<BundleKind, BundleItem[]> {
  return {
    agents: inv.agents.map((a) => ({
      key: a.id,
      kind: 'agents',
      title: a.id,
      summary: a.description,
      chips: [
        ...(a.model ? [{ text: a.model }] : []),
        ...(a.steps.length ? [{ text: plural(a.steps.length, 'step') }] : []),
        ...(a.skills.length ? [{ text: plural(a.skills.length, 'skill') }] : []),
      ],
      groups: [
        { label: 'Model', values: [a.provider && a.model ? `${a.provider} · ${a.model}` : a.model ?? a.provider ?? ''].filter(Boolean) },
        { label: 'Skills', values: a.skills },
        { label: 'Command', values: a.command ? [a.command] : [] },
        { label: 'Built-in tools', values: a.tools },
        { label: 'MCP servers', values: a.mcp },
        { label: 'Runs in steps', values: a.steps },
      ],
    })),
    skills: inv.skills.map((s) => ({
      key: s.id,
      kind: 'skills',
      title: s.id,
      summary: s.description,
      chips: [{ text: `used by ${s.agents.length}` }],
      groups: [{ label: 'Used by agents', values: s.agents }],
    })),
    commands: inv.commands.map((c) => ({
      key: c.id,
      kind: 'commands',
      title: c.id,
      summary: c.description,
      chips: [{ text: `used by ${c.agents.length}` }],
      groups: [{ label: 'Used by agents', values: c.agents }],
    })),
    mcp: inv.mcp.map((m) => ({
      key: m.name,
      kind: 'mcp',
      title: m.name,
      summary: m.command.length ? 'Local server started with the agent' : null,
      chips: [{ text: 'local' }],
      groups: [
        { label: 'Command', values: m.command.length ? [m.command.join(' ')] : [] },
        { label: 'Environment names', values: m.env_names },
        { label: 'Used by agents', values: m.agents },
      ],
    })),
    tools: [
      ...gateway.map((t): BundleItem => ({
        key: t.ref,
        kind: 'tools',
        title: t.ref,
        summary: t.description || null,
        chips: [{ text: t.effect === 'read' ? 'read only' : `writes · ${t.effect}`, tone: t.effect === 'read' ? 'ok' : 'warn' }, ...(t.transport ? [{ text: t.transport }] : [])],
        groups: [{ label: 'Roles allowed', values: t.roles ?? [] }],
      })),
      ...inv.harness_tools.map((t): BundleItem => ({
        key: `builtin:${t.name}`,
        kind: 'tools',
        title: t.name,
        summary: 'Built-in tool, scoped to the step’s checkout',
        chips: [{ text: 'built-in' }, { text: 'read only', tone: 'ok' }],
        groups: [{ label: 'Allowed for agents', values: t.agents }],
      })),
    ],
  };
}

/** Case-insensitive match on the title and summary. */
export const matchItem = (i: BundleItem, term: string) => !term.trim() || `${i.title} ${i.summary ?? ''}`.toLowerCase().includes(term.trim().toLowerCase());
