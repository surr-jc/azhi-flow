import { parse } from 'yaml';
import { AzhiError, ErrorClass } from '../lib/errors.js';

/**
 * An agent profile (`profiles/<name>@<version>.yaml` in the package): instructions plus the
 * model binding. `name: default` defers the model choice to the server (AZHI_ANTHROPIC_MODEL,
 * AZHI_OPENAI_MODEL, AZHI_COPILOT_MODEL or AZHI_CHATGPT_MODEL),
 * so packages stay portable across workspaces with different model access.
 */
export interface AgentProfile {
  model: {
    /** `github-copilot`: GitHub Copilot models through OpenCode, with a Copilot sign-in as the credential. */
    /** `openai-chatgpt`: OpenAI models on a ChatGPT plan through OpenCode, with a ChatGPT sign-in as the credential. */
    provider: 'anthropic' | 'openai' | 'github-copilot' | 'openai-chatgpt' | 'scripted';
    name?: string;
    /** Workspace secret holding the provider API key. */
    credential?: string;
  };
  instructions: string;
  temperature?: number;
  max_output_tokens?: number;
  max_turns?: number;
  /**
   * Prices for estimated cost (USD per million tokens). Without them cost is labelled unavailable,
   * never guessed. For github-copilot they are optional: the server's AZHI_COPILOT_RATES and
   * GitHub's published rates fill in, and cost is counted in AI Credits (see copilot-pricing.ts).
   */
  pricing?: {
    currency?: string;
    input_per_mtok?: number;
    output_per_mtok?: number;
    cache_read_per_mtok?: number;
    cache_write_per_mtok?: number;
    revision?: string;
  };
  /** The scripted provider's turns, for fixtures and tests. */
  script?: ScriptedTurn[];
  /** Executor-specific setup. Ignored by executors it does not name. */
  harness?: { opencode?: OpencodeHarness };
}

/**
 * What an OpenCode agent step brings with it, as files in the package. Azhi writes its own
 * frontmatter for agents and commands (mode, tools, permissions), so a file cannot widen what the
 * step may do; only the description and body are taken from it.
 */
export interface OpencodeHarness {
  /** Markdown file: the agent's prompt (appended to the Azhi system prompt). */
  agent?: string;
  /**
   * Markdown file: a command template run as the first turn, after the step's input (sent as its
   * own message). OpenCode runs !`shell` in templates after substituting $ARGUMENTS, so untrusted
   * input never goes through arguments, and templates may use neither.
   */
  command?: string;
  /** Directories holding a SKILL.md each; loaded with OpenCode's skill tool. */
  skills?: string[];
  /** OpenCode built-in tools to allow. Read-only ones only; scoped to the step's workspace. */
  tools?: string[];
  /** Local stdio MCP servers. Arguments naming a package file are passed as absolute paths. */
  mcp?: Record<string, { command: string[]; environment?: Record<string, string> }>;
  /** `off` leaves the step as written; `on` adds Azhi's search-first guidance to its prompt. Omitted: the worker's AZHI_OPENCODE_TOKEN_SAVING setting (default off). */
  token_saving?: 'on' | 'off';
}

/** Built-in OpenCode tools a profile may allow (verified against OpenCode 1.18.34). */
export const OPENCODE_READ_TOOLS = ['read', 'grep', 'glob', 'skill'];

/** Problems with a profile's OpenCode section; `read` returns a package file's text, if it exists. */
export function opencodeHarnessProblems(h: OpencodeHarness, read: (path: string) => string | undefined): string[] {
  const out: string[] = [];
  const file = (p: unknown, what: string): string | undefined => {
    if (typeof p !== 'string' || !p) out.push(`${what} must be a package path`);
    else {
      const text = read(p);
      if (text === undefined) out.push(`${what} '${p}' is not in the package`);
      return text;
    }
    return undefined;
  };
  if (h.agent !== undefined) file(h.agent, 'harness.opencode.agent');
  if (h.command !== undefined) {
    const template = file(h.command, 'harness.opencode.command');
    if (template !== undefined && /!`|\$ARGUMENTS|\$\d/.test(template)) {
      out.push(`harness.opencode.command '${h.command}' may not use $ARGUMENTS, $1... or !\`shell\` (the step input arrives as its own message, and OpenCode would run shell commands found in it)`);
    }
  }
  if (h.token_saving !== undefined && h.token_saving !== 'on' && h.token_saving !== 'off') out.push(`harness.opencode.token_saving must be 'on' or 'off'`);
  for (const s of h.skills ?? []) file(`${String(s).replace(/\/$/, '')}/SKILL.md`, 'harness.opencode.skills entry');
  for (const t of h.tools ?? []) if (!OPENCODE_READ_TOOLS.includes(t)) out.push(`harness.opencode.tools: '${t}' is not allowed (allowed: ${OPENCODE_READ_TOOLS.join(', ')})`);
  for (const [name, m] of Object.entries(h.mcp ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name === 'azhi') out.push(`harness.opencode.mcp: '${name}' must be lower-case letters, digits and dashes, and not 'azhi'`);
    if (!Array.isArray(m?.command) || !m.command.length || m.command.some((c) => typeof c !== 'string')) out.push(`harness.opencode.mcp.${name}.command must be a list of strings`);
    else for (const arg of m.command.slice(1)) if (/^harness\//.test(arg)) file(arg, `harness.opencode.mcp.${name} file`);
  }
  return out;
}

/** The providers a profile (or a workflow's model defaults) may name. */
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'github-copilot', 'openai-chatgpt'] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

/**
 * A provider and model chosen for a whole workflow or run. They apply only to steps whose profile says
 * `name: default` (or leaves the name out); a step that names its own model keeps its provider and model.
 * A model needs its provider, since model ids mean nothing across providers.
 */
export interface ModelDefaults {
  provider?: ModelProviderName;
  name?: string;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,159}$/;

/** Problems with a model-defaults value, as messages. */
export function modelDefaultsProblems(d: unknown): string[] {
  if (d === undefined || d === null) return [];
  if (typeof d !== 'object' || Array.isArray(d)) return ['model_defaults must be a mapping with provider and name'];
  const { provider, name, ...rest } = d as Record<string, unknown>;
  const out: string[] = Object.keys(rest).map((k) => `model_defaults.${k} is not a known field (use provider and name)`);
  if (provider !== undefined && !MODEL_PROVIDERS.includes(provider as ModelProviderName)) out.push(`model_defaults.provider must be one of ${MODEL_PROVIDERS.join(', ')}`);
  if (name !== undefined && (typeof name !== 'string' || !MODEL_ID.test(name))) out.push('model_defaults.name must be a model id such as claude-sonnet-5');
  if (name !== undefined && provider === undefined) out.push('model_defaults.name needs model_defaults.provider (a model id only means something for its provider)');
  return out;
}

/** Whether the profile leaves its model to the defaults (the server's choice for its provider). */
export function usesDefaultModel(p: AgentProfile): boolean {
  return p.model.provider !== 'scripted' && (!p.model.name || p.model.name === 'default');
}

/**
 * The profile as it runs under the given defaults: a profile that says `name: default` takes the
 * default provider (with that provider's own credential) and model; any other profile is untouched.
 * A default provider without a model uses that provider's server default model.
 */
export function applyModelDefaults(p: AgentProfile, defaults?: ModelDefaults | null): AgentProfile {
  if (!defaults?.provider || !usesDefaultModel(p)) return p;
  const sameProvider = defaults.provider === p.model.provider;
  return { ...p, model: { provider: defaults.provider, name: defaults.name?.trim() || 'default', ...(sameProvider && p.model.credential ? { credential: p.model.credential } : {}) } };
}

export type ScriptedTurn =
  | { tool: string; args: Record<string, unknown> }
  | { output: unknown }
  | { text: string }
  | { usage?: null; tool?: never; output?: never; text?: never };

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function parseProfile(text: string, path: string): AgentProfile {
  let p: AgentProfile;
  try {
    p = parse(text) as AgentProfile;
  } catch (e) {
    throw new AzhiError(ErrorClass.invalidInput, `${path}: ${(e as Error).message}`);
  }
  if (!p || typeof p !== 'object') throw new AzhiError(ErrorClass.invalidInput, `${path}: not a mapping`);
  if (!p.model || !['anthropic', 'openai', 'github-copilot', 'openai-chatgpt', 'scripted'].includes(p.model.provider)) throw new AzhiError(ErrorClass.invalidInput, `${path}: model.provider must be anthropic, openai, github-copilot, openai-chatgpt or scripted`);
  if (typeof p.instructions !== 'string' || !p.instructions.trim()) throw new AzhiError(ErrorClass.invalidInput, `${path}: instructions are required`);
  if (p.model.provider === 'scripted' && !Array.isArray(p.script)) throw new AzhiError(ErrorClass.invalidInput, `${path}: a scripted profile needs a script`);
  return p;
}
