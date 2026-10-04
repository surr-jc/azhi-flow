import { parse } from 'yaml';
import { AzhiError, ErrorClass } from '../lib/errors.js';

/**
 * An agent profile (`profiles/<name>@<version>.yaml` in the package): instructions plus the
 * model binding. `name: default` defers the model choice to the server (AZHI_ANTHROPIC_MODEL),
 * so packages stay portable across workspaces with different model access.
 */
export interface AgentProfile {
  model: {
    provider: 'anthropic' | 'scripted';
    name?: string;
    /** Workspace secret holding the provider API key. */
    credential?: string;
  };
  instructions: string;
  temperature?: number;
  max_output_tokens?: number;
  max_turns?: number;
  /** Prices for estimated cost. Without them cost is labelled unavailable, never guessed. */
  pricing?: { currency: string; input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok?: number; cache_write_per_mtok?: number; revision: string };
  /** The scripted provider's turns, for fixtures and tests. */
  script?: ScriptedTurn[];
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
  if (!p.model || !['anthropic', 'scripted'].includes(p.model.provider)) throw new AzhiError(ErrorClass.invalidInput, `${path}: model.provider must be anthropic or scripted`);
  if (typeof p.instructions !== 'string' || !p.instructions.trim()) throw new AzhiError(ErrorClass.invalidInput, `${path}: instructions are required`);
  if (p.model.provider === 'scripted' && !Array.isArray(p.script)) throw new AzhiError(ErrorClass.invalidInput, `${path}: a scripted profile needs a script`);
  return p;
}
