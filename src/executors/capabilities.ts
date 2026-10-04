/** Executor capability declarations (spec section 9). The run plan evaluates nodes against these. */
export interface ExecutorCapabilities {
  streaming: boolean;
  resume: 'native' | 'checkpoint-only' | 'none';
  cancellation: 'confirmed' | 'best-effort' | 'none';
  gatewayTools: 'native-mcp' | 'bridged' | 'none';
  ambientTools: 'disableable' | 'restrictable' | 'uncontrolled';
  structuredOutput: 'enforced' | 'validated' | 'none';
  usage: 'reported' | 'partial' | 'unavailable';
  platforms: Array<'linux' | 'macos' | 'windows'>;
  /** Fields not yet verified by a conformance run; the run plan marks them unverified. */
  unverified?: Array<keyof Omit<ExecutorCapabilities, 'unverified' | 'compacts'>>;
  /** Whether the executor compacts context itself; if so, the platform does not (spec section 11). */
  compacts: boolean;
}

export interface ExecutorDeclaration {
  id: string;
  version: string;
  capabilities: ExecutorCapabilities;
  notes: string[];
}

export const EXECUTORS: Record<string, ExecutorDeclaration> = {
  'model-agent': {
    id: 'model-agent',
    version: '0.1.0',
    capabilities: {
      streaming: false,
      resume: 'checkpoint-only',
      cancellation: 'confirmed',
      gatewayTools: 'native-mcp',
      ambientTools: 'disableable',
      structuredOutput: 'validated',
      usage: 'reported',
      platforms: ['linux', 'macos', 'windows'],
      compacts: false,
    },
    notes: ['Platform-owned tool loop: every tool call goes through the gateway', 'No ambient tools exist'],
  },
  // Recorded from phase 0 spike 6 (OpenCode 1.18.34); see docs/phase-0-results.md.
  opencode: {
    id: 'opencode',
    version: '1.18.34',
    capabilities: {
      streaming: true,
      resume: 'native',
      cancellation: 'best-effort',
      gatewayTools: 'bridged',
      ambientTools: 'restrictable',
      structuredOutput: 'validated',
      usage: 'partial',
      platforms: ['linux', 'macos'],
      unverified: ['usage', 'structuredOutput', 'cancellation'],
      compacts: true,
    },
    notes: ['Built-in tools restricted by deny-all permission rules; OpenCode still lists them', 'Runs with an isolated HOME so host skills and config do not leak in'],
  },
};
