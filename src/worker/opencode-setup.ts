import { ApplicationFailure } from '@temporalio/common';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { opencodeHarnessProblems, parseProfile, type OpencodeHarness } from '../agents/profile.js';
import { ErrorClass } from '../lib/errors.js';

/**
 * Turns a profile's OpenCode section into files in the step's config folder (OPENCODE_CONFIG_DIR):
 * `agent/<name>.md`, `command/<name>.md` and `skill/<name>/`. Azhi writes the frontmatter of
 * agents and commands itself, so a package file contributes only its description and body and
 * cannot switch tools or permissions back on. Checked against OpenCode 1.18.34.
 */
export interface OpencodeSetup {
  agent: string;
  command?: string;
  tools: Record<string, boolean>;
  mcp: Record<string, { type: 'local'; command: string[]; environment: Record<string, string>; timeout: number; enabled: true }>;
}

const BUILT_IN_AGENTS = new Set(['build', 'plan', 'general', 'explore', 'compaction', 'summary', 'title']);

const inside = (pkgDir: string, p: string) => {
  const full = resolve(pkgDir, p);
  return full.startsWith(resolve(pkgDir) + sep) ? full : undefined;
};

/** The profile's OpenCode section, checked against the package on this worker. */
export function readProfileHarness(pkgDir: string, profile: string): OpencodeHarness | undefined {
  const path = `profiles/${profile}.yaml`;
  const file = inside(pkgDir, path);
  if (!file || !existsSync(file)) return undefined;
  const h = parseProfile(readFileSync(file, 'utf8'), path).harness?.opencode;
  if (!h) return undefined;
  const problems = opencodeHarnessProblems(h, (f) => {
    const full = inside(pkgDir, f);
    return full && existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : undefined;
  });
  if (problems.length) throw ApplicationFailure.create({ type: ErrorClass.invalidInput, message: `${path}: ${problems.join('; ')}`, nonRetryable: true });
  return h;
}

function splitFrontmatter(text: string): { description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text.trim() };
  let meta: unknown;
  try {
    meta = parse(m[1]!);
  } catch {
    meta = undefined;
  }
  const description = meta && typeof meta === 'object' && typeof (meta as { description?: unknown }).description === 'string' ? (meta as { description: string }).description : undefined;
  return { description, body: text.slice(m[0].length).trim() };
}

const nameOf = (p: string) => basename(p).replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
const markdown = (meta: Record<string, unknown>, body: string) => `---\n${stringify(meta).trim()}\n---\n${body}\n`;

/** OpenCode's own secrets in its environment, never passed on to a package's MCP servers. */
export const OPENCODE_PRIVATE_ENV = ['OPENCODE_AUTH_CONTENT', 'OPENCODE_SERVER_PASSWORD'];
export const MCP_LAUNCHER = fileURLToPath(new URL('../../bin/azhi-mcp-launch.js', import.meta.url));

export function writeOpencodeSetup(h: OpencodeHarness, o: { pkgDir: string; configDir: string; system: string; gitEnv: NodeJS.ProcessEnv; workspace?: string; platform?: NodeJS.Platform }): OpencodeSetup {
  const read = (p: string) => readFileSync(inside(o.pkgDir, p)!, 'utf8');
  for (const d of ['agent', 'command', 'skill']) mkdirSync(join(o.configDir, d), { recursive: true });

  let agent = h.agent ? nameOf(h.agent) : 'azhi-step';
  if (BUILT_IN_AGENTS.has(agent)) agent = `azhi-${agent}`;
  const a = h.agent ? splitFrontmatter(read(h.agent)) : { description: undefined, body: '' };
  // The Azhi system prompt (platform rules and the profile's instructions) leads the agent prompt.
  writeFileSync(join(o.configDir, 'agent', `${agent}.md`), markdown({ description: a.description ?? 'Azhi agent step', mode: 'primary' }, [o.system, a.body].filter(Boolean).join('\n\n')));

  let command: string | undefined;
  if (h.command) {
    command = nameOf(h.command);
    const c = splitFrontmatter(read(h.command));
    writeFileSync(join(o.configDir, 'command', `${command}.md`), markdown({ description: c.description ?? 'Azhi agent step', agent }, c.body));
  }

  for (const d of h.skills ?? []) cpSync(inside(o.pkgDir, d.replace(/\/$/, ''))!, join(o.configDir, 'skill', nameOf(d)), { recursive: true });

  const tools: Record<string, boolean> = Object.fromEntries((h.tools ?? []).map((t) => [t, true]));
  const mcp: OpencodeSetup['mcp'] = {};
  for (const [name, m] of Object.entries(h.mcp ?? {})) {
    const [cmd, ...args] = m.command;
    const resolved = [cmd === 'node' ? process.execPath : cmd!, ...args.map((x) => {
      const full = inside(o.pkgDir, x);
      return full && existsSync(full) ? full : x;
    })];
    // Same isolation as the checkout: no host config, credentials or tokens, only what the profile declares.
    const env = Object.fromEntries(Object.entries(o.gitEnv).filter((e): e is [string, string] => typeof e[1] === 'string'));
    // OpenCode starts MCP servers with its own environment added, which holds the model sign-in (OPENCODE_AUTH_CONTENT)
    // and its server password; `env -u` takes them out before the package's server starts. Windows has no `env`,
    // so there a small Node launcher does the same.
    const scrubbed = (o.platform ?? process.platform) === 'win32'
      ? [process.execPath, MCP_LAUNCHER, OPENCODE_PRIVATE_ENV.join(','), '--', ...resolved]
      : ['/usr/bin/env', ...OPENCODE_PRIVATE_ENV.flatMap((k) => ['-u', k]), ...resolved];
    mcp[name] = { type: 'local', command: scrubbed, environment: { ...env, ...(m.environment ?? {}), ...(o.workspace ? { AZHI_WORKSPACE: o.workspace } : {}) }, timeout: 120_000, enabled: true };
    tools[`${name}_*`] = true;
  }
  return { agent, ...(command ? { command } : {}), tools, mcp };
}
