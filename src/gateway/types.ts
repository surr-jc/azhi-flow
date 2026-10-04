import type { EffectClass, JsonSchema } from '../definition/types.js';

export type ToolTransport =
  | { kind: 'builtin'; name: string; config?: Record<string, unknown> }
  | { kind: 'http'; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Record<string, string>; query?: string[] }
  | { kind: 'mcp-stdio'; command: string[]; tool: string; env?: Record<string, string>; cwd?: string };

/** A registered tool revision (spec section 9, "Registration"). */
export interface ToolSpec {
  id: string;
  version: number;
  revision?: number;
  description: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  effect: EffectClass;
  transport: ToolTransport;
  /** Name of a workspace secret, resolved at execution time; never stored in packages. */
  credential?: string;
  timeout?: string;
  rate_limit?: { per_minute: number };
  access?: { roles?: string[] };
  /** Whether this tool's output may enter agent context without tainting it. Default: untrusted. */
  output_trusted?: boolean;
  /** Administrator mark allowing tainted agents to call this write tool without another gate. */
  safe_for_tainted?: boolean;
  /** Fields of a response that identify the source system, used for as-of records. */
  source?: string;
}

export function toolRef(spec: Pick<ToolSpec, 'id' | 'version'>): string {
  return `${spec.id}@${spec.version}`;
}

export function parseToolRef(ref: string): { id: string; version: number } {
  const at = ref.lastIndexOf('@');
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

export interface ToolCatalog {
  get(ref: string): ToolSpec | undefined;
  list(): ToolSpec[];
}

export function staticCatalog(specs: ToolSpec[]): ToolCatalog {
  const byRef = new Map(specs.map((s) => [toolRef(s), s]));
  return { get: (ref) => byRef.get(ref), list: () => [...byRef.values()] };
}
