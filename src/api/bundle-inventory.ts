import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import type { OpencodeHarness } from '../agents/profile.js';

/**
 * What a workflow template brings with it, for the marketplace's "What's inside" view: the agents
 * (profiles), skills, commands, MCP servers and built-in tools its harness declares, and which
 * steps use which. Read from the template's files; text from them is data and is only displayed.
 * Anything a file does not say is null, never guessed. Environment values are never returned.
 */
export interface BundleAgent {
  /** Profile ref, `name@version`. */
  id: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  skills: string[];
  command: string | null;
  tools: string[];
  mcp: string[];
  /** Ids of the workflow steps that run this profile. */
  steps: string[];
}
export interface BundleSkill { id: string; description: string | null; agents: string[] }
export interface BundleCommand { id: string; description: string | null; agents: string[] }
export interface BundleMcp { name: string; command: string[]; env_names: string[]; agents: string[] }
export interface BundleTool { name: string; agents: string[] }
export interface BundleInventory {
  agents: BundleAgent[];
  skills: BundleSkill[];
  commands: BundleCommand[];
  mcp: BundleMcp[];
  harness_tools: BundleTool[];
  files: number;
}

/** `description:` from a markdown file's frontmatter, or null. */
function describe(text: string | undefined): string | null {
  const m = text?.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    const d = (parse(m[1]!) as { description?: unknown } | null)?.description;
    return typeof d === 'string' && d.trim() ? d.trim() : null;
  } catch {
    return null;
  }
}

const IGNORED = new Set(['node_modules', '.git', '.azhi', 'fixtures', '__pycache__', '.venv']);
function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else if (e.name !== 'azhi.config.yaml') n++;
  }
  return n;
}

export function bundleInventory(dir: string, nodes: Array<Record<string, unknown>>): BundleInventory {
  // A path from a profile counts only if it stays inside the template.
  const readText = (p: unknown): string | undefined => {
    if (typeof p !== 'string' || !p) return undefined;
    const full = resolve(dir, p);
    const rel = relative(dir, full);
    if (rel.startsWith('..') || resolve(rel) === rel) return undefined;
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  };
  const stepsBy = new Map<string, string[]>();
  for (const n of nodes) if (typeof n.profile === 'string' && typeof n.id === 'string') stepsBy.set(n.profile, [...(stepsBy.get(n.profile) ?? []), n.id]);

  const profilesDir = join(dir, 'profiles');
  const files = existsSync(profilesDir) ? readdirSync(profilesDir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const agents: BundleAgent[] = [];
  const skills = new Map<string, BundleSkill>();
  const commands = new Map<string, BundleCommand>();
  const mcp = new Map<string, BundleMcp>();
  const tools = new Map<string, BundleTool>();
  const add = <T extends { agents: string[] }>(m: Map<string, T>, key: string, make: () => T, agent: string) => {
    const cur = m.get(key) ?? make();
    if (!cur.agents.includes(agent)) cur.agents.push(agent);
    m.set(key, cur);
  };

  for (const f of files) {
    let p: { model?: { provider?: unknown; name?: unknown }; harness?: { opencode?: OpencodeHarness } } | null;
    try {
      p = parse(readFileSync(join(profilesDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    const id = f.replace(/\.ya?ml$/, '');
    const h = p.harness?.opencode ?? {};
    const skillIds = (h.skills ?? []).filter((s): s is string => typeof s === 'string').map((s) => s.replace(/\/$/, ''));
    const mcpNames = Object.keys(h.mcp ?? {});
    const toolNames = (h.tools ?? []).filter((t): t is string => typeof t === 'string');
    agents.push({
      id,
      description: describe(readText(h.agent)),
      provider: typeof p.model?.provider === 'string' ? p.model.provider : null,
      model: typeof p.model?.name === 'string' ? p.model.name : null,
      skills: skillIds.map((s) => s.split('/').pop()!),
      command: typeof h.command === 'string' ? h.command.split('/').pop()!.replace(/\.md$/, '') : null,
      tools: toolNames,
      mcp: mcpNames,
      steps: stepsBy.get(id) ?? [],
    });
    for (const s of skillIds) add(skills, s, () => ({ id: s.split('/').pop()!, description: describe(readText(`${s}/SKILL.md`)), agents: [] }), id);
    if (typeof h.command === 'string') add(commands, h.command, () => ({ id: h.command!.split('/').pop()!.replace(/\.md$/, ''), description: describe(readText(h.command)), agents: [] }), id);
    for (const [name, m] of Object.entries(h.mcp ?? {})) add(mcp, name, () => ({ name, command: Array.isArray(m?.command) ? m.command.filter((c) => typeof c === 'string') : [], env_names: Object.keys(m?.environment ?? {}), agents: [] }), id);
    for (const t of toolNames) add(tools, t, () => ({ name: t, agents: [] }), id);
  }
  return {
    agents,
    skills: [...skills.values()],
    commands: [...commands.values()],
    mcp: [...mcp.values()],
    harness_tools: [...tools.values()],
    files: existsSync(dir) ? countFiles(dir) : 0,
  };
}
